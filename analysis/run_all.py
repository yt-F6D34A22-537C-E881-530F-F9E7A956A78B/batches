"""pooled検定・daywise検定・組み合わせ検定を1回のデータ読み込みで実行するオーケストレータ。

CIをまたぐキャッシュ（actions/cache等）は、heuristics_YYYYMMDD.json が
平日ごとに増え続けること・生成ロジック見直し時は全体が変わりうることから
実運用ではほぼヒットしないため採用しない（2026-07 検討）。
一方、pooled版・daywise版が同じファイル集合を2回読み込んでいた重複は、
このスクリプトで1回にまとめることで、キャッシュ管理のリスクなしに解消する。

対象期間の指定（2026-07 追加）:
環境変数 ANALYSIS_FROM_DATE / ANALYSIS_TO_DATE（いずれもYYYYMMDD）で
検証対象のシグナル期間（heuristicsの範囲）を絞り込める。
未指定（空文字含む）の場合は、従来通り全期間が対象になる。
.github/workflows/analysis.yml の workflow_dispatch.inputs から渡される想定。

2026-07 追加: 単独TECH_*の検定（pooled・daywise）に加え、複数TECH_*を
組み合わせたAND条件の検定（analyze_heuristics_signal_combinations.py）も実行する。

2026-07 修正: 組み合わせ検定の初版は、実データ規模（TECH_*54列×約100万行/horizon）で
Apriori探索の組み合わせ数が爆発しCIジョブがタイムアウトした
（詳細は analyze_heuristics_signal_combinations.py 冒頭のコメントを参照）。
対処として、(1) pooled検定で有意かつ効果量が大きい上位N件のTECH_*のみを
組み合わせ検定の対象に事前フィルタし、(2) build_long_df()の重複実行を解消し、
(3) 各ステージの所要時間をログ出力するようにした（次回同様の事象が起きた際に
どのステージで詰まったかをすぐ切り分けられるようにするため）。
"""
import os
import re
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.repo_data import load_price_series, load_heuristics
from common.plain_language import annotate_dataframe, build_plain_report
from analyze_heuristics_signals import build_long_df, run_pooled_test
from analyze_heuristics_signals_daywise import run_daywise_test, print_ttest_summary, summarize_daywise_ttest
from analyze_heuristics_signal_combinations import run_combination_test, select_candidate_keys

REPO_ROOT = "."
DATE_RE = re.compile(r"^\d{8}$")


def guide():
    print("########## 現状機能だけで「有意な指標を重視した売買」を行う際の注意点 ##########")
    print("")
    print("・　pooledとdaywiseの両方で有意な指標を優先する：pooled検定単体で有意でも、daywise検定（クロスセクション相関を考慮した、より妥当な検定）で消える指標は「その日の市場全体が動いただけ」の疑いがあるため、両方一致するものの方が信頼度が高いです（4083行目の記述より）。")
    print("・　単一指標の有意性は「組み合わせでも同様に効く」ことを保証しない：これは統計的に一般に知られる注意点で、個々に有意な指標を機械的に足し合わせても、相関構造によっては効果が弱まったり打ち消し合ったりすることがあります（一般的な統計知識であり、本アプリ固有の実装事実ではありません）。")
    print("・　多重検定の性質上、有意判定そのものに一定の偽陽性リスクが残る：FDR補正は「複数指標を同時に検定した際の偽陽性率」を抑えるためのものですが、ゼロにするものではありません。")
    print("###########################################################################")
    print("")
    print("########################### 実行結果の読む順番 ############################")
    print("")
    print("1. summary_plain.txt              ← まずこれだけ読めばOK（統計知識不要）")
    print("2. result_trade_simulation_best.csv ← 「結局どう売買すれば良かったか」の結論")
    print("3. result_all.csv / result_combinations.csv ← 個別指標の詳しい数値")
    print("4. result_daywise_summary.csv     ← 上記の裏付け（日次ベースでも同じ傾向か）")
    print("5. result_daywise.csv             ← 生データ（通常は見なくてOK、13,033行）")
    print("###########################################################################")

def _read_date_env(name: str) -> str | None:
    """環境変数からYYYYMMDD形式の日付を読む。未設定・空文字はNone（=絞り込みなし）。"""
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    if not DATE_RE.match(value):
        raise ValueError(f"{name} は YYYYMMDD 形式で指定してください（指定値: {value!r}）")
    return value


def _elapsed(label: str, start: float) -> None:
    """各ステージの所要時間をログ出力する（2026-07追加。CIタイムアウト事象の切り分け用）。"""
    print(f"[elapsed] {label}: {time.time() - start:.1f}秒")


def main():
    guide()
    from_date = _read_date_env("ANALYSIS_FROM_DATE")
    to_date = _read_date_env("ANALYSIS_TO_DATE")
    if from_date is None and to_date is None:
        print("対象期間: 指定なし（全期間を対象とします）")
    else:
        print(f"対象期間: {from_date or '(先頭)'} 〜 {to_date or '(最新)'}")

    # 価格データ(ohlcv)はto_dateで上限を切らない（common.repo_data.load_price_seriesを参照。
    # heuristicsの期間末尾のフォワードリターン算出に、期間外＝未来側の終値が必要なため）。
    t0 = time.time()
    price, trading_dates = load_price_series(REPO_ROOT, from_date=from_date)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")
    _elapsed("データ読み込み（load_price_series + load_heuristics）", t0)

    Path("analysis/output").mkdir(parents=True, exist_ok=True)

    # long形式データの構築は1回だけ行い、pooled検定・組み合わせ検定の両方で使い回す
    # （2026-07修正。以前は各検定内部でそれぞれ構築しており、327万行規模のネストループを
    # 2回実行する無駄が生じていた）。
    t0 = time.time()
    long_df = build_long_df(price, trading_dates, heur)
    _elapsed("build_long_df（long形式データ構築）", t0)

    print("\n########## pooled検定（Mann-Whitney U + FDR補正） ##########")
    t0 = time.time()
    pooled_df = run_pooled_test(price, trading_dates, heur, precomputed_df=long_df)
    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 200)
    print("\n=== 全結果（p_adj_fdr昇順・上位20件） ===")
    print(pooled_df.head(20).to_string(index=False))
    if not pooled_df.empty:
        print("\n=== 補正後 有意水準5%未満のルール ===")
        sig = pooled_df[pooled_df["p_adj_fdr"] < 0.05]
        print(sig.to_string(index=False) if len(sig) else "該当なし")
    # 2026-07追加: 統計知識がなくても読める説明列（verdict・plain_summary）を付加する
    # （既存列はそのまま維持した上での追加列のため、既存の読み手への影響はない）
    pooled_df = annotate_dataframe(pooled_df, fdr_column="p_adj_fdr", fdr_corrected=True)
    pooled_df.to_csv("analysis/output/result_all.csv", index=False)
    _elapsed("pooled検定", t0)

    print("\n########## daywise検定（Fama-MacBeth風t検定） ##########")
    t0 = time.time()
    daily_df = run_daywise_test(price, trading_dates, heur)
    daily_df.to_csv("analysis/output/result_daywise.csv", index=False)
    print_ttest_summary(daily_df)
    # 2026-07追加: ルールごとの集計結果（従来は標準出力のみ）をCSVとしても保存し、
    # プレーン言語の説明列も付加する。daywise検定はFDR補正を行っていない（既存仕様）ため、
    # fdr_corrected=False を指定し、説明文に「多重検定補正なし」の注意書きを含める。
    daywise_summary_df = summarize_daywise_ttest(daily_df)
    daywise_summary_df = annotate_dataframe(daywise_summary_df, diff_column="mean_diff",
                                             fdr_column="p_value", fdr_corrected=False)
    daywise_summary_df.to_csv("analysis/output/result_daywise_summary.csv", index=False)
    _elapsed("daywise検定", t0)

    print("\n########## 組み合わせ検定（Apriori風探索 + Mann-Whitney U + FDR補正） ##########")
    t0 = time.time()
    # サンプル数が数十万〜100万件規模だとp値だけではほぼ全ルールが有意になってしまうため
    # （大標本下でのp値の性質上の限界）、効果量も加味してpooled検定結果から候補を絞り込む。
    # 全TECH_*（54列）をそのまま組み合わせ探索の対象にすると、size2〜4だけで
    # 最大342,486通りの組み合わせが発生しCIタイムアウトを招くため（2026-07に実際に発生した事象）、
    # 候補を上位十数件に絞ることで組み合わせ数を現実的な範囲（数千通り以下）に抑える。
    candidate_keys = select_candidate_keys(pooled_df)
    print(f"組み合わせ検定の候補キー（{len(candidate_keys)}件）: {candidate_keys}")
    combo_df = run_combination_test(price, trading_dates, heur,
                                     candidate_keys=candidate_keys, precomputed_df=long_df)
    print("\n=== 組み合わせ検定 全結果（p_adj_fdr昇順・上位20件） ===")
    print(combo_df.head(20).to_string(index=False))
    if not combo_df.empty:
        print("\n=== 補正後 有意水準5%未満の組み合わせ ===")
        sig_combo = combo_df[combo_df["p_adj_fdr"] < 0.05]
        print(sig_combo.to_string(index=False) if len(sig_combo) else "該当なし")
    combo_df = annotate_dataframe(combo_df, diff_column="diff", fdr_column="p_adj_fdr", fdr_corrected=True)
    combo_df.to_csv("analysis/output/result_combinations.csv", index=False)
    _elapsed("組み合わせ検定", t0)

    # 2026-07追加: 3種類の検定結果を統合した、統計知識不要の日本語サマリーレポートを生成する
    print("\n########## サマリーレポート（統計知識不要） ##########")
    t0 = time.time()
    plain_report = build_plain_report(pooled_df, daywise_summary_df, combo_df)
    print(plain_report)
    with open("analysis/output/summary_plain.txt", "w", encoding="utf-8") as f:
        f.write(plain_report)
    _elapsed("サマリーレポート生成", t0)


if __name__ == "__main__":
    main()
