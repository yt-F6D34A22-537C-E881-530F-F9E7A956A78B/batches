"""analysis/rank_stocks_by_strategy.py

result_trade_simulation_best.csv（simulate_trades.py が算出した「ルールごとの最良売買パターン」）
を使い、各ルールについて「そのルールに従って売買を繰り返した場合、元本を最も増やせた銘柄」の
上位20銘柄をランキングする。

# 元本の増え方（複利）について
同一銘柄で同じルールのシグナルが複数回出た場合、実際の投資家は前の取引で得た（あるいは
失った）資金を使って次の取引を行うと考えられるため、単純合算ではなく複利
（capital *= (1 + リターン) の繰り返し）で最終的な元本の増加倍率を算出する。

# 取引の重複について
同一銘柄で保有期間が重なる複数のシグナルが出た場合（エントリーからエグジットまでの間に
次のシグナルが発生した場合）、現実には同じ資金を2つの取引に同時に使うことはできない。
そのため、シグナル発生日の古い順に処理し、直前の取引がまだ「保有中」（エグジット日を
過ぎていない）場合、次のシグナルはスキップする（非重複・逐次再投資モデル）。

# 異常値の扱い
simulate_trades.py で検出した「|リターン|> OUTLIER_ABS_RETURN_THRESHOLD」の取引
（株式分割・併合が未調整の疑いがあるデータ）を複利計算にそのまま含めると、
特定の異常データ1件だけでランキング上位が決まってしまう。そのため、そうした取引は
複利計算から除外する（n_trades_excluded_outlier 列で除外件数を明示する）。

# 実行の前提
result_trade_simulation_best.csv（simulate_trades.py の実行結果）を読み込むため、
simulate_trades.py を先に実行しておく必要がある。
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common.cli import parse_date_range
from common.repo_data import load_ohlc_series, load_heuristics
from simulate_trades import _find_signal_instances, _price_at, OUTLIER_ABS_RETURN_THRESHOLD, FEE_RATE

TOP_N = 20  # 出力する上位銘柄数（推測初期値。要調整）


def _parse_rule_row(row) -> tuple[list[str], str, str, int]:
    rule_keys = sorted(k.strip() for k in row["rule"].split(" AND "))
    return rule_keys, row["entry_type"], row["exit_type"], int(row["days_after_signal"])


def rank_stocks_for_rule(ohlc: dict, trading_dates: list[str], heur: dict,
                          rule_keys: list[str], entry_type: str, exit_type: str, n: int) -> pd.DataFrame:
    """1つのルール・1つの売買パターンについて、銘柄ごとに逐次複利シミュレーションを行い、
    最終的な元本の増加倍率が大きい順にランキングしたDataFrame（上位TOP_N件）を返す。
    """
    date_index = {d: i for i, d in enumerate(trading_dates)}
    instances = _find_signal_instances(heur, trading_dates, rule_keys)

    # _find_signal_instances() は日付昇順（sorted(heur.keys())）で構築されているため、
    # 同一銘柄codeの出現順もそのまま時系列順になる（改めてのソートは不要）。
    by_code: dict[str, list[str]] = {}
    for code, signal_date in instances:
        by_code.setdefault(code, []).append(signal_date)

    entry_price_type = "open" if entry_type == "next_open" else "close"
    records = []

    for code, signal_dates in by_code.items():
        capital = 1.0
        n_used = 0
        n_excluded_outlier = 0
        first_date, last_date = None, None
        locked_until_idx = -1  # 直前の取引のエグジットidx。これ以前のシグナルはスキップ（重複回避）

        for signal_date in signal_dates:
            idx = date_index.get(signal_date)
            if idx is None:
                continue
            entry_idx = idx + 1
            exit_idx = idx + n
            if exit_idx < entry_idx or exit_idx >= len(trading_dates):
                continue
            if entry_idx <= locked_until_idx:
                continue  # 直前の取引がまだ保有中のためスキップ（非重複・逐次再投資モデル）

            entry_price = _price_at(ohlc, code, trading_dates[entry_idx], entry_price_type)
            exit_price = _price_at(ohlc, code, trading_dates[exit_idx], exit_type)
            if entry_price is None or exit_price is None or entry_price == 0:
                continue

            ret = (exit_price / entry_price - 1.0) - FEE_RATE
            if abs(ret) > OUTLIER_ABS_RETURN_THRESHOLD:
                n_excluded_outlier += 1
                locked_until_idx = exit_idx
                continue  # 異常値の疑いがある取引は複利計算から除外（冒頭コメント参照）

            capital *= (1.0 + ret)
            n_used += 1
            locked_until_idx = exit_idx
            first_date = first_date or trading_dates[entry_idx]
            last_date = trading_dates[exit_idx]

        if n_used == 0:
            continue

        records.append({
            "code": code,
            "final_multiple": capital,
            "total_return_pct": (capital - 1.0) * 100,
            "n_trades_used": n_used,
            "n_trades_excluded_outlier": n_excluded_outlier,
            "first_trade_date": first_date,
            "last_trade_date": last_date,
        })

    ranking = pd.DataFrame(records)
    if ranking.empty:
        return ranking
    return ranking.sort_values("final_multiple", ascending=False).head(TOP_N).reset_index(drop=True)


def run_ranking(repo_root: str = ".", best_pattern_path: str | None = None,
                 from_date: str | None = None, to_date: str | None = None) -> pd.DataFrame:
    """result_trade_simulation_best.csv の全ルールについて銘柄ランキングを計算し、
    1つのDataFrameにまとめて返す（rule列で区別する）。
    """
    best_pattern_path = best_pattern_path or f"{repo_root}/analysis/output/result_trade_simulation_best.csv"
    if not Path(best_pattern_path).exists():
        print(f"警告: {best_pattern_path} が見つかりません。simulate_trades.py を先に実行してください。")
        return pd.DataFrame()

    best_df = pd.read_csv(best_pattern_path)
    ohlc, trading_dates = load_ohlc_series(repo_root, from_date=from_date)
    heur = load_heuristics(repo_root, from_date=from_date, to_date=to_date)

    all_rankings = []
    for _, row in best_df.iterrows():
        rule_keys, entry_type, exit_type, n = _parse_rule_row(row)
        rule_label = " AND ".join(rule_keys)
        print(f"{rule_label}（{entry_type}/{exit_type}/{n}営業日後）の銘柄ランキングを計算中...")
        ranking = rank_stocks_for_rule(ohlc, trading_dates, heur, rule_keys, entry_type, exit_type, n)
        if ranking.empty:
            continue
        ranking.insert(0, "rule", rule_label)
        ranking.insert(1, "entry_type", entry_type)
        ranking.insert(2, "exit_type", exit_type)
        ranking.insert(3, "days_after_signal", n)
        ranking.insert(4, "rank", range(1, len(ranking) + 1))
        all_rankings.append(ranking)

    if not all_rankings:
        return pd.DataFrame()
    return pd.concat(all_rankings, ignore_index=True)


if __name__ == "__main__":
    REPO_ROOT = "."
    from_date, to_date = parse_date_range("戦略別・銘柄ランキング算出を単体実行する")

    result_df = run_ranking(REPO_ROOT, from_date=from_date, to_date=to_date)

    pd.set_option("display.width", 160)
    pd.set_option("display.max_rows", 400)

    if result_df.empty:
        print("ランキングを算出できませんでした。先に simulate_trades.py を実行してください。")
    else:
        print(f"\n=== ルールごとの銘柄ランキング（上位{TOP_N}件） ===")
        print(result_df.to_string(index=False))
        Path("analysis/output").mkdir(parents=True, exist_ok=True)
        result_df.to_csv("analysis/output/result_stock_ranking.csv", index=False)
