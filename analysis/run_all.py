"""pooled検定・daywise検定を1回のデータ読み込みで両方実行するオーケストレータ。

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
"""
import os
import re
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.repo_data import load_price_series, load_heuristics
from analyze_heuristics_signals import run_pooled_test
from analyze_heuristics_signals_daywise import run_daywise_test, print_ttest_summary

REPO_ROOT = "."
DATE_RE = re.compile(r"^\d{8}$")


def _read_date_env(name: str) -> str | None:
    """環境変数からYYYYMMDD形式の日付を読む。未設定・空文字はNone（=絞り込みなし）。"""
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    if not DATE_RE.match(value):
        raise ValueError(f"{name} は YYYYMMDD 形式で指定してください（指定値: {value!r}）")
    return value


def main():
    from_date = _read_date_env("ANALYSIS_FROM_DATE")
    to_date = _read_date_env("ANALYSIS_TO_DATE")
    if from_date is None and to_date is None:
        print("対象期間: 指定なし（全期間を対象とします）")
    else:
        print(f"対象期間: {from_date or '(先頭)'} 〜 {to_date or '(最新)'}")

    # 価格データ(ohlcv)はto_dateで上限を切らない（common.repo_data.load_price_seriesを参照。
    # heuristicsの期間末尾のフォワードリターン算出に、期間外＝未来側の終値が必要なため）。
    price, trading_dates = load_price_series(REPO_ROOT, from_date=from_date)
    print(f"ohlcvアーカイブ収録日付: {trading_dates[0]} 〜 {trading_dates[-1]}（計{len(trading_dates)}日）")

    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)
    heur_dates = sorted(heur.keys())
    print(f"heuristicsファイル日付: {heur_dates[0]} 〜 {heur_dates[-1]}（計{len(heur_dates)}日）")

    Path("analysis/output").mkdir(parents=True, exist_ok=True)

    print("\n########## pooled検定（Mann-Whitney U + FDR補正） ##########")
    pooled_df = run_pooled_test(price, trading_dates, heur)
    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 200)
    print("\n=== 全結果（p_adj_fdr昇順・上位20件） ===")
    print(pooled_df.head(20).to_string(index=False))
    if not pooled_df.empty:
        print("\n=== 補正後 有意水準5%未満のルール ===")
        sig = pooled_df[pooled_df["p_adj_fdr"] < 0.05]
        print(sig.to_string(index=False) if len(sig) else "該当なし")
    pooled_df.to_csv("analysis/output/result_all.csv", index=False)

    print("\n########## daywise検定（Fama-MacBeth風t検定） ##########")
    daily_df = run_daywise_test(price, trading_dates, heur)
    daily_df.to_csv("analysis/output/result_daywise.csv", index=False)
    print_ttest_summary(daily_df)


if __name__ == "__main__":
    main()
