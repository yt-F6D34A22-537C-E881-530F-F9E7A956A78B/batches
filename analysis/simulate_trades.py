"""analysis/simulate_trades.py

依頼1（プレーン言語化）・依頼2（組み合わせ検定のタイムアウト対処）で【有望】と判定された
TECH_*指標（単独・複数の組み合わせ双方）を対象に、heuristics_YYYYMMDD.json でシグナルが
出た銘柄について、その後の株価推移（ohlcv_YYYYMMDD.json）を用いて売買シミュレーションを行い、
「どの始値・終値で売買すれば利益を最大化できたか」を再現性のある形（乱数不使用）で算出する。

# 実行の前提
本スクリプトは analysis/output/result_all.csv・analysis/output/result_combinations.csv
（いずれも run_all.py の実行で生成される、verdict列付きのファイル）を読み込んで
対象ルールを決定する。そのため、run_all.py を先に実行しておく必要がある
（2026-07 現時点では run_all.py には統合せず、独立実行スクリプトとする方針のため）。

# なぜ「翌営業日の始値」が現実的なエントリー価格の下限か
heuristics.yml は大引け後（JST 17:07〜21:07）に実行されるため、シグナル発生日 d の
始値・終値のどちらも、シグナルを知った時点では既に取引できない。そのため、本スクリプトの
エントリー価格の選択肢には「d 当日の価格」を含めず、「d の翌営業日の始値・終値」のみを
候補とする（詳細は仕様書.md heuristics.yml.schedule を参照）。

# 探索空間
エントリー価格: 翌営業日始値 / 翌営業日終値
エグジット価格: エントリーからN営業日後の始値 / 終値
保有期間 N: 1・3・5営業日（analyze_heuristics_signals.HORIZONS と統一）
これら 2×2×3=12通りの売買パターンを、対象ルールごとに総当たりする。

# 再現性について
乱数は一切使用しない。同一の heuristics_YYYYMMDD.json 群・ohlcv_YYYYMMDD.json 群・
同一の ANALYSIS_FROM_DATE/TO_DATE を与えれば常に同一の結果になる
（辞書・DataFrameの並び順に依存する箇所は、日付・コードとも明示的にソートして処理する）。

# 手数料・スリッページについて
初期値として一切考慮しない（FEE_RATE=0.0）。仕様書に実際の証券会社の手数料体系の
記載がないための推測に基づく初期設計であり、実コストを反映したい場合は FEE_RATE を
往復の概算比率（例: 0.002 = 0.2%）で設定できるようパラメータ化してある。

# 2026-07修正（ロング／ショート両対応化。再訂正版）
従来は verdict【有望】であれば diff（シグナル発生時の平均フォワードリターン - baseline）
の符号を問わずロング（買い）として一律シミュレーションしていた。実データ検証
（result_all.csv）で【有望】判定ルールの約半数が diff<0 であることが判明したため、
当初は diff の符号でロング/ショートを振り分けていたが、これは設計上の誤りだった。
diff は baseline との“相対”指標であり、diff<0 の【有望】ルールの実に8割は
mean_return_signaled（絶対リターン）自体はプラスだった（強い上昇相場のbaselineほど
には上がらないだけで、依然上昇はしている）。この状態のルールを空売り対象にすると、
実際には上昇している銘柄を売ることになり、win_rateが45〜51%まで落ち込むことを
実データのシミュレーション結果で確認した。そのため、方向判定の基準を diff ではなく
mean_return_signaled（絶対リターン）の符号に変更した。mean_return_signaledがhorizon間
で一貫して正のルールをロング対象、一貫して負のルールをショート対象とし、それ以外
（diffは負だが絶対リターンは正、または符号混在）のルールはいずれの対象にもしない。
heuristics_conditions.js には元々下降を示唆する指標（TECH_DOWN_TREND_END等）が
ショート判断の材料としても使う想定で設けられているため、方向判定の考え方自体は
既存のheuristics設計思想と整合する。

# 2026-07修正（n=1グリッドの無効な組み合わせ除外）
entry_idx（シグナル翌営業日）と exit_idx（シグナル日からN営業日後）が
n=1のとき同一営業日になる。このうち「翌営業日の始値で買い、同日終値で売る」
（本docstring記載の日計りパターン）以外の組み合わせ（次の終値で買って同日の始値で売る＝
時系列が逆転して実行不可能／始値で買って同日の始値で売る＝常にリターン0）は、
無効な組み合わせとしてシミュレーション対象から除外する
（TECH_MOMIAIの検証時、mean_return=0.0・win_rate=0.0という不自然な結果で実際に発覚した）。
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.tech_rules import classify
from common.cli import parse_date_range
from common.repo_data import load_ohlc_series, load_heuristics

HOLDING_PERIODS = [1, 3, 5]           # analyze_heuristics_signals.HORIZONS と統一
ENTRY_TYPES = ["next_open", "next_close"]
EXIT_TYPES = ["open", "close"]
FEE_RATE = 0.0                        # 往復の概算手数料率（推測初期値。要調整）
MIN_SAMPLE_SIZE = 30                  # 集計対象とする最小サンプル数（既存の統計検定と揃えている）

# 2026-07追加: 個別取引のリターンがこの絶対値を超えたら「異常値の疑いあり」として
# result_trade_simulation_outliers.csv に記録する（初期値は推測。株式分割・併合が
# 未調整のまま ohlcv データに混入している場合、数百%〜数万%というありえないリターンが
# 生じることが実際に確認されたための対処）。集計値（mean/median等）の計算からは除外しない
# （除外の是非は利用者側の確認事項とし、まずは「気づけるようにする」ことを優先する）。
OUTLIER_ABS_RETURN_THRESHOLD = 0.90


def load_promising_rules(result_all_path: str, result_combinations_path: str) -> list[tuple[list[str], str]]:
    """result_all.csv・result_combinations.csv から【有望】判定のルールを読み込み、
    (TECH_*キーのリスト（単独なら1要素、組み合わせなら複数要素）, "long"|"short") の
    タプルのリストとして返す。

    同じルールが horizon_days（1・3・5）ごとに複数行存在するため、TECH_*キーの
    組み合わせ単位で重複排除する（本スクリプトは独自に保有期間を総当たりするため、
    元のpooled/組み合わせ検定でどのhorizonで有望だったかは問わない）。

    2026-07修正（初版）: diffがhorizon間で一貫して正のルールをロング対象、
    一貫して負のルールをショート対象としていた。

    2026-07再修正（設計誤りの訂正）: 上記初版のロジックには誤りがあった。diff は
    「シグナル発生時の平均フォワードリターン - baseline」という“相対”指標であり、
    diff<0 は必ずしも「その銘柄が下落する」ことを意味しない。実データ検証の結果、
    diff<0の【有望】ルール40行のうち32行（8割）は mean_return_signaled（絶対リターン）
    自体はプラスだった（＝強い上昇相場のbaselineほどには上がらないだけで、依然
    上昇はしている）。この状態のルールを空売り対象にした結果、実際には上昇している
    銘柄を売ることになり、win_rateが45〜51%（ほぼコイントス以下）に落ち込むことを
    実データのシミュレーション結果で確認した。
    そのため方向判定の基準を diff ではなく mean_return_signaled（絶対リターン）の
    符号に変更する。mean_return_signaledがhorizon間で一貫して正のルールをロング対象、
    一貫して負のルールをショート対象とする。diffは負だがmean_return_signaledは正、
    または符号がhorizon間で混在するルールは、ロングとして使うには相対的に弱く、
    ショートとして使うには方向が逆であるため、いずれの対象にもせず除外する
    （除外理由をログ出力する）。
    """
    rule_returns: dict[tuple[str, ...], list[float]] = {}

    for path in (result_all_path, result_combinations_path):
        if not Path(path).exists():
            print(f"警告: {path} が見つかりません。run_all.py を先に実行してください。スキップします。")
            continue
        df = pd.read_csv(path)
        if df.empty or "verdict" not in df.columns:
            continue
        promising = df[df["verdict"] == "【有望】"]
        for _, row in promising.iterrows():
            # "TECH_A AND TECH_B=signal (vs baseline)" / "TECH_A=signal (vs baseline)" 形式から
            # TECH_*キー部分のみを抽出する
            keys_part = row["rule"].split("=", 1)[0]
            keys = tuple(sorted(k.strip() for k in keys_part.split(" AND ")))
            rule_returns.setdefault(keys, []).append(row["mean_return_signaled"])

    rule_directions: list[tuple[list[str], str]] = []
    for keys, returns in sorted(rule_returns.items()):
        if all(r > 0 for r in returns):
            rule_directions.append((list(keys), "long"))
        elif all(r < 0 for r in returns):
            rule_directions.append((list(keys), "short"))
        else:
            print(
                f"  → {' AND '.join(keys)}: mean_return_signaled（絶対リターン）の符号が"
                f"horizon間で混在、またはロング/ショートいずれとしても方向が一致しないため、"
                f"対象から除外します（mean_return_signaled={[round(r, 6) for r in returns]}）。"
            )

    return rule_directions


def _find_signal_instances(heur: dict, trading_dates: list[str], rule_keys: list[str]) -> list[tuple[str, str]]:
    """rule_keys（1つ以上のTECH_*キー）全てがsignal判定になっている (code, date) の一覧を返す。
    単独ルール（rule_keys が1要素）の場合も、組み合わせルールと同じロジックで扱える。
    """
    trading_date_set = set(trading_dates)
    instances = []
    for d in sorted(heur.keys()):
        if d not in trading_date_set:
            continue  # ohlcvアーカイブの範囲外の日付は、翌営業日を特定できないため対象外
        codes_today = heur[d]
        for code in sorted(codes_today.keys()):
            techs = codes_today[code]
            if all(classify(techs.get(key)) == "signal" for key in rule_keys):
                instances.append((code, d))
    return instances


def _price_at(ohlc: dict, code: str, date: str, price_type: str):
    bar = ohlc.get(code, {}).get(date)
    if bar is None:
        return None
    return bar.get("o") if price_type == "open" else bar.get("c")


def simulate_rule(ohlc: dict, trading_dates: list[str],
                   instances: list[tuple[str, str]], direction: str = "long"
                   ) -> tuple[pd.DataFrame, list[dict], dict[tuple[str, str, int], list[float]]]:
    """1つのルール（単独 or 組み合わせ）について、12通りの売買パターンごとに
    リターン分布を集計する。instances は _find_signal_instances() の戻り値。

    N（days_after_signal）の定義は analyze_heuristics_signals.HORIZONS と揃えてあり、
    「シグナル発生日 d から N 営業日後」を指す（d 自身を0営業日目として数える）。
    エントリーは常に d の翌営業日（=1営業日目）のため、
    実際の保有期間（エントリー〜エグジット）は N-1 営業日になる
    （N=1の場合はエントリー日当日の始値→終値、という日計りパターンに相当する）。

    @param direction: "long"（買い。価格上昇で利益）または "short"（空売り。価格下落で利益）。
        2026-07追加。load_promising_rules() が判定したdiffの符号（"long"|"short"）を
        そのまま渡す想定。損益の符号だけが反転し、集計方法（win_rate等）は共通。

    戻り値は (集計DataFrame, 異常値の疑いがある個別取引の一覧, パターンごとの生リターン)
    のタプル（2026-07追加の異常値一覧に加え、2026-08にraw_returns_by_patternを追加）。
    raw_returns_by_pattern は {(entry_type, exit_type, days_after_signal): [リターン, ...]}
    で、集計後のDataFrame（平均・勝率等）だけでは行えない検定（t検定・ブートストラップ信頼区間等）を
    呼び出し側で行うために追加した。既存の呼び出し箇所（simulate_trades.py の run_simulation()）は
    3つ目の戻り値を単に無視すればよく、後方互換の破壊は伴わない（タプルの要素数が増えるだけ）。
    """
    date_index = {d: i for i, d in enumerate(trading_dates)}
    records = []
    outliers = []
    raw_returns_by_pattern: dict[tuple[str, str, int], list[float]] = {}

    for entry_type in ENTRY_TYPES:
        for exit_type in EXIT_TYPES:
            for n in HOLDING_PERIODS:
                # 2026-07修正: n=1（エントリー翌営業日とエグジット対象日が同一営業日になる
                # ケース）のうち、本モジュールdocstring記載の意図どおりの「翌営業日の始値で
                # 買い（売り）、同日終値で売る（買い戻す）」（日計り）以外の組み合わせを除外する。
                # entry_type="next_close" の場合、始値は終値より時系列上先に発生するため、
                # 「終値でエントリーして同日の始値でエグジット」は時系列が逆転しており実行不可能。
                # entry_type="next_open" かつ exit_type="open" は、エントリー価格・エグジット
                # 価格が完全に同一になり、常にリターン0の無意味な"取引"になる
                # （TECH_MOMIAIの検証時、mean_return=0.0・win_rate=0.0という不自然な結果で発覚）。
                if n == 1 and not (entry_type == "next_open" and exit_type == "close"):
                    continue

                returns = []
                for code, signal_date in instances:
                    idx = date_index.get(signal_date)
                    if idx is None:
                        continue
                    entry_idx = idx + 1  # 翌営業日
                    exit_idx = idx + n   # シグナル日からN営業日後（analyze_heuristics_signals.pyのHORIZONSと同じ定義）
                    if exit_idx < entry_idx or exit_idx >= len(trading_dates):
                        continue
                    entry_price_type = "open" if entry_type == "next_open" else "close"
                    entry_date = trading_dates[entry_idx]
                    exit_date = trading_dates[exit_idx]
                    entry_price = _price_at(ohlc, code, entry_date, entry_price_type)
                    exit_price = _price_at(ohlc, code, exit_date, exit_type)
                    if entry_price is None or exit_price is None or entry_price == 0:
                        continue
                    raw_ret = exit_price / entry_price - 1.0
                    # ショート（空売り）の場合は価格下落が利益になるため符号を反転する。
                    # 手数料（FEE_RATE）はロング・ショート問わず往復コストとして減算する。
                    ret = (raw_ret if direction == "long" else -raw_ret) - FEE_RATE
                    returns.append(ret)

                    if abs(ret) > OUTLIER_ABS_RETURN_THRESHOLD:
                        outliers.append({
                            "code": code, "signal_date": signal_date, "direction": direction,
                            "entry_type": entry_type, "exit_type": exit_type, "days_after_signal": n,
                            "entry_date": entry_date, "exit_date": exit_date,
                            "entry_price": entry_price, "exit_price": exit_price, "return": ret,
                        })

                if len(returns) < MIN_SAMPLE_SIZE:
                    continue

                s = pd.Series(returns)
                raw_returns_by_pattern[(entry_type, exit_type, n)] = returns

                # [2026-08追加] win_rateだけでなく期待値（プロフィットファクター等）も
                # あわせて評価できるようにする。勝率が50%台でも、勝ったときのリターンが
                # 負けたときより十分大きければ、トータルではプラスの期待値になり得るため
                # （win_rateだけで戦略の良し悪しを判断すると見誤るケースがある）。
                wins = s[s > 0]
                losses = s[s < 0]
                avg_win = wins.mean() if len(wins) > 0 else 0.0
                avg_loss = losses.mean() if len(losses) > 0 else 0.0  # 負の値のまま保持
                total_gain = wins.sum()
                total_loss = abs(losses.sum())
                # 損失が皆無の場合はNaN（プロフィットファクターが数学的に未定義のため、
                # 便宜的に無限大や0を入れて誤解を招くより、非数として明示する）
                profit_factor = (total_gain / total_loss) if total_loss > 0 else float("nan")

                records.append({
                    "entry_type": entry_type,
                    "exit_type": exit_type,
                    "days_after_signal": n,
                    "n_trades": len(s),
                    "mean_return": s.mean(),
                    "median_return": s.median(),
                    "win_rate": (s > 0).mean(),
                    "avg_win": avg_win,
                    "avg_loss": avg_loss,
                    "profit_factor": profit_factor,
                    "worst_return": s.min(),
                    "best_return": s.max(),
                })

    return pd.DataFrame(records), outliers, raw_returns_by_pattern


def run_simulation(repo_root: str = ".", from_date: str | None = None,
                    to_date: str | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """全ての【有望】ルールについてシミュレーションを実行し、
    (集計結果, 異常値の疑いがある個別取引一覧) のタプルを返す。
    """
    rule_direction_sets = load_promising_rules(
        f"{repo_root}/analysis/output/result_all.csv",
        f"{repo_root}/analysis/output/result_combinations.csv",
    )
    n_long = sum(1 for _, d in rule_direction_sets if d == "long")
    n_short = sum(1 for _, d in rule_direction_sets if d == "short")
    print(f"シミュレーション対象ルール数: {len(rule_direction_sets)}（ロング: {n_long} / ショート: {n_short}）")

    ohlc, trading_dates = load_ohlc_series(repo_root, from_date=from_date)
    heur = load_heuristics(repo_root, from_date=from_date, to_date=to_date)

    all_records = []
    all_outliers = []
    for rule_keys, direction in rule_direction_sets:
        # 2026-07変更: ruleラベルに [LONG]/[SHORT] を付与し、集計後もどちらの
        # ポジション方向のシミュレーション結果か一目で分かるようにする
        # （同一TECH_*キーの組み合わせがロング・ショート両方に属することはない設計のため、
        # select_best_patterns() の rule 単位のgroupbyには影響しない）。
        rule_label = " AND ".join(rule_keys) + f" [{direction.upper()}]"
        instances = _find_signal_instances(heur, trading_dates, rule_keys)
        print(f"{rule_label}: シグナル発生件数 {len(instances)}件")
        if not instances:
            continue
        sim_df, outliers, _ = simulate_rule(ohlc, trading_dates, instances, direction)
        if outliers:
            print(f"  ⚠ 異常値の疑いがある取引を{len(outliers)}件検出"
                  f"（|リターン|>{OUTLIER_ABS_RETURN_THRESHOLD*100:.0f}%）")
            for o in outliers:
                o["rule"] = rule_label
            all_outliers.extend(outliers)
        if sim_df.empty:
            continue
        sim_df.insert(0, "rule", rule_label)
        sim_df.insert(1, "direction", direction)
        sim_df.insert(2, "combo_size", len(rule_keys))
        all_records.append(sim_df)

    result_df = pd.concat(all_records, ignore_index=True) if all_records else pd.DataFrame()
    outliers_df = pd.DataFrame(all_outliers) if all_outliers else pd.DataFrame()
    return result_df, outliers_df


def select_best_patterns(result_df: pd.DataFrame, rank_by: str = "median_return") -> pd.DataFrame:
    """ルールごとに、rank_byの値が最大の売買パターンのみを抽出する（既定: 中央値リターン）。

    中央値を既定にしている理由: 平均値は少数の極端な当たり銘柄に引っ張られやすく、
    「再現性のある」実務的な判断材料としては中央値の方が代表性が高いと考えられるため
    （推測に基づく初期設計。用途に応じて mean_return / win_rate 等に切り替え可能）。

    2026-07注記: rule列には " [LONG]"/" [SHORT]" のポジション方向ラベルが付与されて
    いるため、同一TECH_*キーの組み合わせがロング・ショート双方に属することはなく、
    groupby("rule") の単位はそのまま「1ルール1ポジション方向」に対応する。
    """
    if result_df.empty:
        return result_df
    idx = result_df.groupby("rule")[rank_by].idxmax()
    return result_df.loc[idx].sort_values(rank_by, ascending=False).reset_index(drop=True)


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("売買シミュレーション（翌営業日エントリー基準）を単体実行する")

    result_df, outliers_df = run_simulation(REPO_ROOT, from_date=from_date, to_date=to_date)

    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 200)

    Path("analysis/output").mkdir(parents=True, exist_ok=True)

    if result_df.empty:
        print("シミュレーション対象となる【有望】ルールが見つかりませんでした。"
              "先に run_all.py を実行し、result_all.csv / result_combinations.csv を生成してください。")
    else:
        print("\n=== 全売買パターンの集計結果 ===")
        print(result_df.to_string(index=False))

        best_df = select_best_patterns(result_df)
        print("\n=== ルールごとの最良パターン（中央値リターン降順） ===")
        print(best_df.to_string(index=False))

        result_df.to_csv("analysis/output/result_trade_simulation.csv", index=False)
        best_df.to_csv("analysis/output/result_trade_simulation_best.csv", index=False)

        # 2026-07追加: 勝率（win_rate）を主指標として比較したい運用のため、
        # median_return基準のbest_dfとは別に、win_rate基準の最良パターンも出力する。
        # 既存のresult_trade_simulation_best.csv（rank_stocks_by_strategy.pyが
        # median_return基準を前提に参照している）はそのまま維持し、追加ファイルとする。
        best_by_winrate_df = select_best_patterns(result_df, rank_by="win_rate")
        best_by_winrate_df.to_csv("analysis/output/result_trade_simulation_best_by_winrate.csv", index=False)
        print("\n=== ルールごとの最良パターン（勝率降順・参考） ===")
        print(best_by_winrate_df.to_string(index=False))

    if not outliers_df.empty:
        print(f"\n⚠ 異常値の疑いがある個別取引を合計{len(outliers_df)}件検出しました"
              f"（|リターン|>{OUTLIER_ABS_RETURN_THRESHOLD*100:.0f}%）。"
              "result_trade_simulation_outliers.csv をご確認ください。")
        print("上位10件（リターンの絶対値が大きい順）:")
        print(outliers_df.reindex(outliers_df["return"].abs().sort_values(ascending=False).index)
              .head(10).to_string(index=False))
        outliers_df.to_csv("analysis/output/result_trade_simulation_outliers.csv", index=False)
    else:
        print(f"\n異常値の疑いがある取引（|リターン|>{OUTLIER_ABS_RETURN_THRESHOLD*100:.0f}%）は検出されませんでした。")
