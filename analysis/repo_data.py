"""data/ohlcv, data/heuristics（リポジトリの恒久保存データ）を読み込む共通ローダー。

2026-07 のアーキテクチャ変更（単一ファイル data.json 洗い替え方式
→ 日付ごとの ohlcv_YYYYMMDD.json 恒久保存。仕様書.md 3049/3085/3168行目）
に追随するため、分析スクリプト側もこの新形式を前提に読み込む。

パフォーマンス方針:
分析は「試行錯誤しながら何度も実行する」運用が前提のため、実行のたびに
半年分（数百ファイル）のJSONを毎回フルパースするとクリティカルパスになる。
そのため、対象ファイル一覧＋各ファイルの内容ハッシュからキャッシュキーを作り、
ファイル構成・内容に変化がない再実行時はパース結果（pickle）をそのまま再利用する。
"""
import glob
import hashlib
import json
import pickle
import re
from pathlib import Path

OHLCV_GLOB = "data/ohlcv/*/ohlcv_*.json"
HEURISTICS_GLOB = "data/heuristics/*/heuristics_*.json"
DATE_RE = re.compile(r"(\d{8})\.json$")
CACHE_DIR = "analysis/.cache"  # .gitignore に追加し、リポジトリにはコミットしないこと


def _date_from_path(path: str) -> str:
    m = DATE_RE.search(path)
    if not m:
        raise ValueError(f"日付を抽出できないファイル名です: {path}")
    return m.group(1)


def _scan(repo_root: str, pattern: str, from_date: str | None = None, to_date: str | None = None) -> list[str]:
    """ファイル一覧を取得する。from_date/to_date（YYYYMMDD文字列）を指定した場合、
    ファイル名から抽出した日付でその範囲に絞り込む。両方 None なら従来通り全ファイル対象
    （2026-07、from_date/to_dateによる期間指定機能を追加。後方互換のためデフォルトは全期間）。
    """
    paths = sorted(glob.glob(str(Path(repo_root) / pattern)))
    if from_date is None and to_date is None:
        return paths
    filtered = []
    for p in paths:
        d = _date_from_path(p)
        if from_date is not None and d < from_date:
            continue
        if to_date is not None and d > to_date:
            continue
        filtered.append(p)
    return filtered


def _cache_key(paths: list[str]) -> str:
    """ファイルパス一覧＋内容ハッシュからキャッシュキーを作る。

    mtimeではなく内容ハッシュを使う理由（2026-07 修正）:
    GitHub Actions では actions/checkout のたびに全ファイルのmtimeが
    checkout時刻に揃ってしまい、内容が同じでもmtimeベースのキーは
    毎回変わってしまう。内容ハッシュにすることで、同一リポジトリの
    クローン内でファイル内容が変わらない限り正しくキャッシュが効く。
    """
    h = hashlib.sha1()
    for p in paths:
        h.update(p.encode())
        with open(p, "rb") as f:
            h.update(f.read())
    return h.hexdigest()


def _load_with_cache(cache_name: str, paths: list[str], builder, use_cache: bool):
    if not use_cache:
        return builder(paths)

    cache_dir = Path(CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = _cache_key(paths)
    cache_file = cache_dir / f"{cache_name}.{key}.pkl"

    if cache_file.exists():
        with open(cache_file, "rb") as f:
            return pickle.load(f)

    result = builder(paths)

    # ファイル構成・内容が変わって新しいキーになった場合、古い世代のキャッシュファイルは
    # 溜まり続けるとディスクを圧迫するので削除する。
    for old in cache_dir.glob(f"{cache_name}.*.pkl"):
        if old != cache_file:
            old.unlink(missing_ok=True)

    with open(cache_file, "wb") as f:
        pickle.dump(result, f)
    return result


def _build_price(paths: list[str]):
    """仕様書.md scripts.fetch.outputFormat:
    1ファイル＝1日分、内容は {コード: {o,h,l,c,v}} のフラットな構造（銘柄コード直下）。
    旧 data.json は {コード: {日付: {...}}} という逆の階層だったため、ここで転置する。
    """
    price: dict[str, dict[str, float]] = {}
    trading_dates: list[str] = []
    for path in paths:
        date = _date_from_path(path)
        trading_dates.append(date)
        with open(path, encoding="utf-8") as f:
            day = json.load(f)
        for code, ohlcv in day.items():
            if not isinstance(ohlcv, dict) or "c" not in ohlcv:
                continue  # error銘柄（取得失敗）は日付キーを持たないため自然に除外される
            price.setdefault(code, {})[date] = ohlcv["c"]
    return price, sorted(trading_dates)


def _build_heuristics(paths: list[str]):
    heur: dict[str, dict] = {}
    for path in paths:
        date = _date_from_path(path)
        with open(path, encoding="utf-8") as f:
            heur[date] = json.load(f)
    return heur


def _build_ohlc(paths: list[str]):
    """{code: {date: {"o":.., "h":.., "l":.., "c":..}}} を返す（始値も保持する版）。

    2026-07追加: 既存の _build_price() は終値（c）のみを保持し、始値（o）を破棄していた。
    売買シミュレーション機能（simulate_trades.py）では「シグナル発生翌営業日の始値で
    エントリーする」といった検証が必要なため、始値も保持する別系統のビルダーを追加した。

    既存の _build_price() / load_price_series() は、pooled検定・daywise検定・組み合わせ検定
    という高頻度に実行される既存3スクリプトが依存しており、挙動・キャッシュキー
    （cache_name="price"）を変更するリスクを避けるため、あえて統合（共通化）せず
    独立した関数・独立したキャッシュ名前空間（cache_name="ohlc"）として追加した
    （二重パースにはなるが、simulate_trades.py は既存3スクリプトのように毎回実行される
    ものではないため、実行頻度に見合わないリスクは取らない方針とした）。
    """
    ohlc: dict[str, dict[str, dict]] = {}
    trading_dates: list[str] = []
    for path in paths:
        date = _date_from_path(path)
        trading_dates.append(date)
        with open(path, encoding="utf-8") as f:
            day = json.load(f)
        for code, bar in day.items():
            if not isinstance(bar, dict) or "c" not in bar or "o" not in bar:
                continue  # error銘柄（取得失敗）は日付キーを持たないため自然に除外される
            ohlc.setdefault(code, {})[date] = {
                "o": bar["o"], "h": bar.get("h"), "l": bar.get("l"), "c": bar["c"],
            }
    return ohlc, sorted(trading_dates)


def load_ohlc_series(repo_root: str, from_date: str | None = None, use_cache: bool = True):
    """{code: {date: {"o","h","l","c"}}} と、取引日一覧を返す（始値を含む版）。

    2026-07追加。load_price_series() と同じ仕組み（ファイル一覧のスキャン・内容ハッシュに
    よるキャッシュ）を踏襲しているが、始値（o）・高値（h）・安値（l）も保持する点が異なる。
    to_date（上限）を受け付けない理由も load_price_series() と同じ
    （フォワードリターン算出にシグナル日より後の価格が必要なため）。
    """
    paths = _scan(repo_root, OHLCV_GLOB, from_date=from_date, to_date=None)
    return _load_with_cache("ohlc", paths, _build_ohlc, use_cache)


def load_price_series(repo_root: str, from_date: str | None = None, use_cache: bool = True):
    """{code: {date: close}} と、取引日一覧（当該日のファイルが存在する＝近似的な開場日）を返す。

    注意（推測）: 仕様書2214行目の通り、ohlcvアーカイブは暦としての開場日情報を
    正式には保証しない（本アプリの /trading_dates は日経平均を別途参照している）。
    本関数は簡易近似としてファイル存在＝取引日とみなす。

    to_date（上限）は受け付けない。フォワードリターン算出にはシグナル日より後の
    株価が必要なため、価格データ側は heuristics側の期間指定（to_date）に関わらず、
    常にアーカイブの最新日まで読み込む必要がある（2026-07 追加）。
    from_date（下限）のみ、読み込み量削減のために任意で指定できる。
    """
    paths = _scan(repo_root, OHLCV_GLOB, from_date=from_date, to_date=None)
    return _load_with_cache("price", paths, _build_price, use_cache)


def _build_ohlc_v(paths: list[str]):
    """{code: {date: {"o","h","l","c","v"}}} を返す（出来高付き版）。

    2026-08追加: 出来高（急増度）を既存TECH_*シグナルと掛け合わせて検証する
    ための専用ローダー。既存の _build_ohlc() / load_ohlc_series()
    （simulate_trades.py・rank_stocks_by_strategy.py が依存）の挙動・
    キャッシュキー（cache_name="ohlc"）を変更するリスクを避けるため、
    _build_price() に対して _build_ohlc() を独立追加したのと同じ方針で、
    あえて統合（共通化）せず独立した関数・独立したキャッシュ名前空間
    （cache_name="ohlc_v"）として追加した（二重パースにはなるが、
    出来高分析は既存3スクリプトのように高頻度実行されるものではないため、
    実行頻度に見合わないリスクは取らない方針とした）。
    """
    ohlc: dict[str, dict[str, dict]] = {}
    trading_dates: list[str] = []
    for path in paths:
        date = _date_from_path(path)
        trading_dates.append(date)
        with open(path, encoding="utf-8") as f:
            day = json.load(f)
        for code, bar in day.items():
            if not isinstance(bar, dict) or "c" not in bar or "v" not in bar:
                continue  # error銘柄（取得失敗）は日付キーを持たないため自然に除外される
            ohlc.setdefault(code, {})[date] = {
                "o": bar.get("o"), "h": bar.get("h"), "l": bar.get("l"), "c": bar["c"], "v": bar["v"],
            }
    return ohlc, sorted(trading_dates)


def load_ohlc_series_with_volume(repo_root: str, from_date: str | None = None, use_cache: bool = True):
    """{code: {date: {"o","h","l","c","v"}}} と、取引日一覧を返す（出来高を含む版）。

    2026-08追加。load_ohlc_series() と同じ仕組み（ファイル一覧のスキャン・
    内容ハッシュによるキャッシュ）を踏襲しているが、出来高（v）も保持する点が異なる。
    to_date（上限）を受け付けない理由も load_price_series() 等と同じ
    （フォワードリターン算出にシグナル日より後の価格が必要なため）。
    """
    paths = _scan(repo_root, OHLCV_GLOB, from_date=from_date, to_date=None)
    return _load_with_cache("ohlc_v", paths, _build_ohlc_v, use_cache)


def load_heuristics(repo_root: str, from_date: str | None = None, to_date: str | None = None,
                     use_cache: bool = True) -> dict:
    """{date: {code: {TECH_*: 値, ...}}} を返す。既に日付別ファイルのため転置は不要。

    from_date/to_date（いずれもYYYYMMDD、省略可）を指定すると、シグナル評価の
    対象期間をその範囲に絞り込む。両方省略時は現状と同じく全期間が対象（2026-07 追加）。
    """
    paths = _scan(repo_root, HEURISTICS_GLOB, from_date=from_date, to_date=to_date)
    return _load_with_cache("heuristics", paths, _build_heuristics, use_cache)
