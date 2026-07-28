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


def load_promising_rules(result_all_path: str, result_combinations_path: str) -> list[list[str]]:
    """result_all.csv・result_combinations.csv から【有望】判定のルールを読み込み、
    TECH_*キーのリスト（単独なら1要素、組み合わせなら複数要素）のリストとして返す。

    同じルールが horizon_days（1・3・5）ごとに複数行存在するため、TECH_*キーの
    組み合わせ単位で重複排除する（本スクリプトは独自に保有期間を総当たりするため、
    元のpooled/組み合わせ検定でどのhorizonで有望だったかは問わない）。
    """
    rule_key_sets: set[tuple[str, ...]] = set()

    for path in (result_all_path, result_combinations_path):
        if not Path(path).exists():
            print(f"警告: {path} が見つかりません。run_all.py を先に実行してください。スキップします。")
            continue
        df = pd.read_csv(path)
        if df.empty or "verdict" not in df.columns:
            continue
        promising = df[df["verdict"] == "【有望】"]
        for rule in promising["rule"]:
            # "TECH_A AND TECH_B=signal (vs baseline)" / "TECH_A=signal (vs baseline)" 形式から
            # TECH_*キー部分のみを抽出する
            keys_part = rule.split("=", 1)[0]
            keys = tuple(sorted(k.strip() for k in keys_part.split(" AND ")))
            rule_key_sets.add(keys)

    return [list(keys) for keys in sorted(rule_key_sets)]


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


def simulate_rule(ohlc: dict, trading_dates: list[str], instances: list[tuple[str, str]]) -> pd.DataFrame:
    """1つのルール（単独 or 組み合わせ）について、12通りの売買パターンごとに
    リターン分布を集計する。instances は _find_signal_instances() の戻り値。

    N（days_after_signal）の定義は analyze_heuristics_signals.HORIZONS と揃えてあり、
    「シグナル発生日 d から N 営業日後」を指す（d 自身を0営業日目として数える）。
    エントリーは常に d の翌営業日（=1営業日目）のため、
    実際の保有期間（エントリー〜エグジット）は N-1 営業日になる
    （N=1の場合はエントリー日当日の始値→終値、という日計りパターンに相当する）。
    """
    date_index = {d: i for i, d in enumerate(trading_dates)}
    records = []

    for entry_type in ENTRY_TYPES:
        for exit_type in EXIT_TYPES:
            for n in HOLDING_PERIODS:
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
                    entry_price = _price_at(ohlc, code, trading_dates[entry_idx], entry_price_type)
                    exit_price = _price_at(ohlc, code, trading_dates[exit_idx], exit_type)
                    if entry_price is None or exit_price is None or entry_price == 0:
                        continue
                    ret = (exit_price / entry_price - 1.0) - FEE_RATE
                    returns.append(ret)

                if len(returns) < MIN_SAMPLE_SIZE:
                    continue

                s = pd.Series(returns)
                records.append({
                    "entry_type": entry_type,
                    "exit_type": exit_type,
                    "days_after_signal": n,
                    "n_trades": len(s),
                    "mean_return": s.mean(),
                    "median_return": s.median(),
                    "win_rate": (s > 0).mean(),
                    "worst_return": s.min(),
                    "best_return": s.max(),
                })

    return pd.DataFrame(records)


def run_simulation(repo_root: str = ".", from_date: str | None = None, to_date: str | None = None) -> pd.DataFrame:
    """全ての【有望】ルールについてシミュレーションを実行し、結果を1つのDataFrameにまとめて返す。"""
    rule_key_sets = load_promising_rules(
        f"{repo_root}/analysis/output/result_all.csv",
        f"{repo_root}/analysis/output/result_combinations.csv",
    )
    print(f"シミュレーション対象ルール数: {len(rule_key_sets)}")

    ohlc, trading_dates = load_ohlc_series(repo_root, from_date=from_date)
    heur = load_heuristics(repo_root, from_date=from_date, to_date=to_date)

    all_records = []
    for rule_keys in rule_key_sets:
        rule_label = " AND ".join(rule_keys)
        instances = _find_signal_instances(heur, trading_dates, rule_keys)
        print(f"{rule_label}: シグナル発生件数 {len(instances)}件")
        if not instances:
            continue
        sim_df = simulate_rule(ohlc, trading_dates, instances)
        if sim_df.empty:
            continue
        sim_df.insert(0, "rule", rule_label)
        sim_df.insert(1, "combo_size", len(rule_keys))
        all_records.append(sim_df)

    if not all_records:
        return pd.DataFrame()
    return pd.concat(all_records, ignore_index=True)


def select_best_patterns(result_df: pd.DataFrame, rank_by: str = "median_return") -> pd.DataFrame:
    """ルールごとに、rank_byの値が最大の売買パターンのみを抽出する（既定: 中央値リターン）。

    中央値を既定にしている理由: 平均値は少数の極端な当たり銘柄に引っ張られやすく、
    「再現性のある」実務的な判断材料としては中央値の方が代表性が高いと考えられるため
    （推測に基づく初期設計。用途に応じて mean_return / win_rate 等に切り替え可能）。
    """
    if result_df.empty:
        return result_df
    idx = result_df.groupby("rule")[rank_by].idxmax()
    return result_df.loc[idx].sort_values(rank_by, ascending=False).reset_index(drop=True)


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("売買シミュレーション（翌営業日エントリー基準）を単体実行する")

    result_df = run_simulation(REPO_ROOT, from_date=from_date, to_date=to_date)

    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 200)

    if result_df.empty:
        print("シミュレーション対象となる【有望】ルールが見つかりませんでした。"
              "先に run_all.py を実行し、result_all.csv / result_combinations.csv を生成してください。")
    else:
        print("\n=== 全売買パターンの集計結果 ===")
        print(result_df.to_string(index=False))

        best_df = select_best_patterns(result_df)
        print("\n=== ルールごとの最良パターン（中央値リターン降順） ===")
        print(best_df.to_string(index=False))

        Path("analysis/output").mkdir(parents=True, exist_ok=True)
        result_df.to_csv("analysis/output/result_trade_simulation.csv", index=False)
        best_df.to_csv("analysis/output/result_trade_simulation_best.csv", index=False)
