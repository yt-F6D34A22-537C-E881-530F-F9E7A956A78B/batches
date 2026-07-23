"""analysis/*.py をコマンドラインから単体実行する際の対象期間パース用共通関数。

run_all.py の _read_date_env() と同一ロジックを、
analyze_heuristics_signals.py / analyze_heuristics_signals_daywise.py の
単体実行時にも共通で使えるようここに切り出したもの
（run_all.py 側は複数の環境変数を1箇所でまとめて検証する都合上、
 自身の _read_date_env() を保持し続けるため、本モジュールへの一本化は行わない）。

環境変数 ANALYSIS_FROM_DATE / ANALYSIS_TO_DATE（いずれもYYYYMMDD）が対象。
未設定・空文字の場合は該当側の絞り込みなし（None）として扱う。
"""
import os
import re

DATE_RE = re.compile(r"^\d{8}$")


def _read_date_env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    if not value:
        return None
    if not DATE_RE.match(value):
        raise ValueError(f"{name} は YYYYMMDD 形式で指定してください（指定値: {value!r}）")
    return value


def parse_date_range(description: str) -> tuple[str | None, str | None]:
    """ANALYSIS_FROM_DATE / ANALYSIS_TO_DATE から対象期間を読み取り、(from_date, to_date) を返す。

    description は単体実行時にどの検定を実行しているかを示す見出し文字列
    （呼び出し側の analyze_heuristics_signals*.py を参照）。
    """
    from_date = _read_date_env("ANALYSIS_FROM_DATE")
    to_date = _read_date_env("ANALYSIS_TO_DATE")
    if from_date is None and to_date is None:
        print(f"{description}: 対象期間は指定なし（全期間を対象とします）")
    else:
        print(f"{description}: 対象期間 {from_date or '(先頭)'} 〜 {to_date or '(最新)'}")
    return from_date, to_date