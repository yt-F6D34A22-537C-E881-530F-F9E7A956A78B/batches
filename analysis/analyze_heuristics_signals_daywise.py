import sys
from pathlib import Path

import pandas as pd
import numpy as np
from scipy.stats import ttest_1samp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.repo_data import load_price_series, load_heuristics
from common.tech_rules import classify, discover_tech_columns
from common.cli import parse_date_range

HORIZON = 5


def fwd_date(trading_dates, d, n):
    idx = trading_dates.index(d)
    return trading_dates[idx + n] if idx + n < len(trading_dates) else None


def run_daywise_test(price: dict, trading_dates: list, heur: dict) -> pd.DataFrame:
    """日次差分を1標本としたFama-MacBeth風のt検定。

    run_all.py から呼ぶ場合も、本ファイル単体で実行する場合も、
    データの読み込みは1回で済むようこの関数にロジックを切り出している。

    各日について「シグナルあり群の平均リターン - シグナルなし群の平均リターン」を1つの観測値とし、
    日をまたいだ t検定（観測数=シグナル可能な日数のみ）で有意性を判定する。
    これはクロスセクション（銘柄間）の相関を無視しない、より妥当な検定。
    2026-07、5種類の代表ルールから仕様書記載の全TECH_*（40種類超）へ対象を拡張。
    """
    heur_dates = sorted(heur.keys())
    usable_dates = [d for d in heur_dates if d in trading_dates]
    candidate_rules = discover_tech_columns(heur[usable_dates[0]]) if usable_dates else []

    rows = []
    for d in usable_dates:
        fd = fwd_date(trading_dates, d, HORIZON)
        if fd is None:
            continue
        codes_today = heur[d]
        for rule in candidate_rules:
            sig_rets, base_rets = [], []
            for code, techs in codes_today.items():
                entry = price.get(code, {}).get(d)
                exitp = price.get(code, {}).get(fd)
                if entry is None or exitp is None or entry == 0:
                    continue
                r = exitp / entry - 1.0
                cls = classify(techs.get(rule))
                if cls == "signal":
                    sig_rets.append(r)
                elif cls == "baseline":
                    base_rets.append(r)
            if sig_rets and base_rets:
                rows.append({"date": d, "rule": rule,
                             "n_sig": len(sig_rets), "n_base": len(base_rets),
                             "diff": (sum(sig_rets)/len(sig_rets)) - (sum(base_rets)/len(base_rets))})

    return pd.DataFrame(rows)


def summarize_daywise_ttest(daily_df: pd.DataFrame) -> pd.DataFrame:
    """daywise検定（日次差分を1標本としたt検定）の結果を、ルールごとに集計したDataFrameで返す。

    2026-07追加: 従来 print_ttest_summary() が標準出力に印字するだけで、
    集計結果（ルールごとのn_days・mean_diff・p値）をCSV等の形で保存していなかった。
    プレーン言語サマリー機能（common/plain_language.py）で再利用するため、
    集計ロジックをこの関数に切り出した（print_ttest_summary()の出力内容・書式は不変）。

    注意（既存仕様のまま）: この集計はpooled検定・組み合わせ検定と異なり、
    ルール間の多重検定補正（FDR補正）を行っていない生のp値である。
    ルール数（40種類超）ぶん同時に検定しているため、統計的に厳密には
    pooled検定と同じ基準（p<0.05）で「有意」と判断するのはやや楽観的である点に留意。
    """
    rows = []
    for rule in daily_df["rule"].unique():
        diffs = daily_df.loc[daily_df["rule"] == rule, "diff"]
        if len(diffs) < 2:
            continue
        stat, p = ttest_1samp(diffs, 0)
        rows.append({"rule": rule, "n_days": len(diffs), "mean_diff": diffs.mean(), "p_value": p})
    return pd.DataFrame(rows)


def print_ttest_summary(daily_df: pd.DataFrame) -> None:
    print("\n=== 日次差分を1標本とした片側t検定（Fama-MacBeth風） ===")
    if daily_df.empty:
        print("日次差分を1件も作成できませんでした（対象期間が狭すぎる可能性があります。"
              f"HORIZON={HORIZON}営業日先までのデータが必要です）")
        return
    summary_df = summarize_daywise_ttest(daily_df)
    for _, row in summary_df.iterrows():
        print(f"{row['rule']:35s} n_days={row['n_days']}  mean_diff={row['mean_diff']:+.5f}  p={row['p_value']:.4f}")


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("daywise検定（Fama-MacBeth風t検定）を単体実行する")

    price, trading_dates = load_price_series(REPO_ROOT)
    heur = load_heuristics(REPO_ROOT, from_date=from_date, to_date=to_date)

    daily_df = run_daywise_test(price, trading_dates, heur)
    print(daily_df.to_string(index=False))
    print_ttest_summary(daily_df)
