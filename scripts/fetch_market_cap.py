"""
market_cap.json 生成スクリプト（2026-07 新設）

目的:
  各モードの検索結果に「時価総額」列を追加するにあたり、時価総額の算出に
  必要な「発行済株式数」を銘柄コードごとに取得し、market_cap.json として
  出力する。

  時価総額そのもの（円建ての金額）ではなく発行済株式数を保存するのは、
  株価は日々変動するのに対し発行済株式数は株式分割・自己株買い等が
  ない限り短期間ではほぼ変化しないため。main.py 側で
  「発行済株式数 × その時点の終値」として都度計算する（app/main.py の
  calc_market_cap() を参照）。

実行頻度の想定:
  発行済株式数は変化が緩やかなため、data.json（日次）や margin.json ほど
  高頻度に更新する必要はない。.github/workflows/market_cap.yml では
  週次（毎週日曜）での実行を想定している。

出力形式:
  {"7203": 1234567000, "9984": 987654321, ...}
  （コード → 発行済株式数〔株〕。取得できなかった銘柄はキー自体を含めない）

前提・注意点:
  - yfinance の Ticker.fast_info は Ticker.info よりも軽量・高速だが、
    銘柄によっては shares 系のキーが欠落することがあるため、
    fast_info で取得できない場合のみ info にフォールバックする
    （info は重いため、全銘柄で毎回使うことは避ける）。
  - 対象銘柄数（約4000銘柄）が多いため、ThreadPoolExecutor で並列実行する。
    ただし main.py の compare/block モードと異なり、本スクリプトは
    ユーザーの操作を待たせるものではなくスケジュール実行のバッチ処理のため、
    Yahoo Finance 側のレート制限を避ける観点から並列数は控えめにしている。
  - 本スクリプトは ticker_list（東証上場銘柄一覧）を main.py と同じ
    EXCEL_URL から取得する。URL は環境変数 TICKER_LIST_EXCEL_URL で
    上書き可能（未設定時は main.py 側と同じ既定値を使用）。
"""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO

import pandas as pd
import requests
import yfinance as yf

# main.py の BASE_URL と同一のリポジトリを既定値とする
# （実際のURLは main.py 側の定義に合わせて必要に応じて書き換えること）
DEFAULT_EXCEL_URL = (
    "https://raw.githubusercontent.com/"
    "yt-F6D34A22-537C-E881-530F-F9E7A956A78B/batches/refs/heads/main/data/data_j.xlsx"
)
EXCEL_URL = os.environ.get("TICKER_LIST_EXCEL_URL", DEFAULT_EXCEL_URL)

OUTPUT_PATH = os.environ.get("MARKET_CAP_OUTPUT_PATH", "data/market_cap.json")

# 並列実行数。バッチ処理のため main.py の COMPARE_FETCH_MAX_WORKERS(8) より
# 抑えめにし、全銘柄（約4000件）を数時間かけて処理することを許容する。
MAX_WORKERS = 5

# 1銘柄あたりのリクエスト間に挟む最小間隔（秒）。レート制限対策。
REQUEST_INTERVAL_SEC = 0.2


def load_ticker_codes() -> list[str]:
    """東証上場銘柄一覧（Excel）から証券コード一覧を取得する"""
    resp = requests.get(EXCEL_URL)
    resp.raise_for_status()
    df = pd.read_excel(BytesIO(resp.content))
    return [str(c) for c in df["コード"].tolist()]


def fetch_shares_outstanding(code: str) -> int | None:
    """
    指定銘柄コードの発行済株式数を取得する。
    fast_info を優先し、取得できない場合のみ info にフォールバックする。
    どちらでも取得できない場合は None を返す。
    """
    symbol = f"{code}.T"
    try:
        time.sleep(REQUEST_INTERVAL_SEC)
        ticker = yf.Ticker(symbol)

        try:
            shares = ticker.fast_info.get("shares")
            if shares:
                return int(shares)
        except Exception:
            pass

        # fast_info で取得できなかった銘柄のみ info にフォールバック
        # （info は重いリクエストのため、全銘柄で常用はしない）
        info = ticker.info
        shares = info.get("sharesOutstanding")
        if shares:
            return int(shares)

        return None
    except Exception as e:
        print(f"[WARN] {code}: 発行済株式数の取得に失敗しました（{e}）", file=sys.stderr)
        return None


def main():
    codes = load_ticker_codes()
    print(f"対象銘柄数: {len(codes)}")

    market_cap = {}
    completed = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_shares_outstanding, code): code for code in codes}
        for future in as_completed(futures):
            code = futures[future]
            completed += 1
            try:
                shares = future.result()
                if shares:
                    market_cap[code] = shares
            except Exception as e:
                print(f"[WARN] {code}: 予期しないエラー（{e}）", file=sys.stderr)

            if completed % 100 == 0:
                print(f"進捗: {completed}/{len(codes)}")

    os.makedirs(os.path.dirname(OUTPUT_PATH) or ".", exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(market_cap, f, ensure_ascii=False)

    print(f"取得完了: {len(market_cap)}/{len(codes)} 銘柄 → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
