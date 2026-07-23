"""TECH_* シグナルを「シグナルあり群」「ベースライン群」に分類する共通ロジック。

仕様書.md scripts.heuristics_conditions.runAllConditions.valueConversions（2748〜2784行目）
より、TECH_* の値は以下4種が混在する:
  - bool（大半のルール）
  - 1 / null（酒田五法系。boolean ? 1 : null に変換済み。int_val型・multiplier=2に対応）
  - "up" / "down" / "flat"（トレンド系）
  - dict（RULE9 / GRANVILLE / CYCLE_PROGRESS / FUSHIME。direction キーを持つものはそこから抽出）

分類不能な値は明示的に "skip" とし、誤ったシグナルを検定に混入させない
（既存2スクリプトが持つ「今回対象外」方針を全ルールへ一般化したもの）。
"""


def classify(value) -> str:
    """戻り値: "signal" | "baseline" | "skip" """
    if isinstance(value, bool):
        return "signal" if value else "baseline"
    if value is None:
        return "baseline"  # 酒田五法系: null = シグナルなし
    if isinstance(value, int):  # bool は int のサブクラスだが、上のbool分岐で先に捕捉済み
        return "signal" if value == 1 else "skip"
    if isinstance(value, str):
        if value == "up":
            return "signal"
        if value == "down":
            return "baseline"
        return "skip"  # "flat" 等は判定対象外
    if isinstance(value, dict):
        direction = value.get("direction")
        if direction == "up":
            return "signal"
        if direction == "down":
            return "baseline"
        return "skip"  # direction を持たない dict（FUSHIME等）は今回対象外
    return "skip"


def discover_tech_columns(day_records: dict) -> list[str]:
    """{code: {TECH_*: 値, ...}} の集合から TECH_* キー一覧を収集する。"""
    keys: set[str] = set()
    for record in day_records.values():
        keys.update(k for k in record if k.startswith("TECH_"))
    return sorted(keys)
