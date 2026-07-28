"""analysis/common/plain_language.py

統計的検定結果（p値・FDR補正後p値・フォワードリターン差）を、統計の知識がない
読み手にも伝わる日本語の説明文に変換する共通ロジック。

# なぜ必要か（2026-07 追加の経緯）
result_all.csv 等の生の検定結果は、以下のようにサンプル数が数十万〜100万件規模のため、
「p_adj_fdr < 0.05（統計的に有意）」がほぼ全ての行で成立してしまう
（大標本下ではp値の性質上、些細な効果量でも有意と判定されやすいため）。
そのため「有意 = 儲かる」と単純に読んでしまうと、実務上ほぼ意味のない
（フォワードリターン差が0.1%にも満たない）指標まで「有意」として拾ってしまう。
本モジュールは、統計的有意性（p値）と実務的な効果量（diffの絶対値）の
両方を組み合わせて判定し、平易な日本語の一言サマリー（verdict）と
詳細説明（detail）を生成する。

# 各種しきい値について
以下の SIGNIFICANCE_*・EFFECT_SIZE_* の各しきい値はいずれも初期値（推測値）。
実データでの見え方を踏まえて調整する想定。
"""
from dataclasses import dataclass

# 効果量（フォワードリターン差の絶対値）の区分しきい値
EFFECT_SIZE_NONE = 0.001    # 0.1%未満：ほぼ差なし
EFFECT_SIZE_SMALL = 0.003   # 0.1%〜0.3%：小さい
EFFECT_SIZE_MEDIUM = 0.01   # 0.3%〜1.0%：中程度、1.0%以上：大きい

# サンプル数がこれ未満の場合、結果の安定性について注意書きを付加する
MIN_RELIABLE_SAMPLE_SIZE = 100

# サンプル数がこれ以上の場合、「大標本によるp値の見かけ上の有意」の注意書きを付加する
LARGE_SAMPLE_WARNING_THRESHOLD = 50_000


@dataclass
class PlainExplanation:
    verdict: str          # 一言タグ（【有望】【留意】【参考】等）
    headline: str          # 一文サマリー
    detail: str             # 補足説明（注意点を含む）


def _effect_size_label(abs_diff: float) -> str:
    if abs_diff < EFFECT_SIZE_NONE:
        return "ほぼ差がない"
    if abs_diff < EFFECT_SIZE_SMALL:
        return "小さいながら観測できる差がある"
    if abs_diff < EFFECT_SIZE_MEDIUM:
        return "実務的に意味がありそうな差がある"
    return "大きな差がある"


def _significance_label(p_value: float, fdr_corrected: bool) -> str:
    correction_note = "（複数指標を同時比較した際の偽陽性リスクを補正済み）" if fdr_corrected else \
        "（※この検定は多重検定補正を行っていないため、より慎重に解釈してください）"
    if p_value >= 0.05:
        return f"統計的には「偶然のばらつきと区別できない」水準です{correction_note}"
    if p_value >= 0.01:
        return f"一定の統計的裏付けがあります{correction_note}"
    if p_value >= 0.001:
        return f"強い統計的裏付けがあります{correction_note}"
    return f"非常に強い統計的裏付けがあります{correction_note}"


def explain_result(rule: str, diff: float, p_value: float, n_signaled: int, n_baseline: int,
                    fdr_corrected: bool = True) -> PlainExplanation:
    """1つの検定結果（1行）を、統計知識がなくても読める説明に変換する。

    rule: TECH_*ルール名（表示用。「TECH_XXX=signal (vs baseline)」等の生の列値をそのまま渡してよい）
    diff: シグナルあり群 - ベースライン群のフォワードリターン差（例: 0.01 = 1%）
    p_value: 統計的有意性の指標（result_all.csv等では p_adj_fdr 列を渡すことを推奨）
    n_signaled / n_baseline: シグナルあり群・ベースライン群それぞれのサンプル数
    fdr_corrected: p_valueが多重検定補正（FDR）済みかどうか。daywise検定の生値を渡す場合はFalse
    """
    abs_diff = abs(diff)
    direction = "上昇" if diff > 0 else "下落" if diff < 0 else "変化なし"
    pct = abs_diff * 100

    is_significant = p_value < 0.05
    is_meaningful_effect = abs_diff >= EFFECT_SIZE_SMALL
    low_sample = n_signaled < MIN_RELIABLE_SAMPLE_SIZE or n_baseline < MIN_RELIABLE_SAMPLE_SIZE
    large_sample = n_signaled + n_baseline >= LARGE_SAMPLE_WARNING_THRESHOLD

    if is_significant and is_meaningful_effect and not low_sample:
        verdict = "【有望】"
    elif is_significant and not is_meaningful_effect:
        verdict = "【留意】"
    elif low_sample:
        verdict = "【参考（サンプル少）】"
    else:
        verdict = "【参考】"

    headline = (
        f"{verdict} {rule}：シグナルが出た銘柄は、出ていない銘柄と比べて"
        f"平均で{pct:.2f}%ほど{direction}する傾向が見られました。"
    )

    detail_parts = [
        _significance_label(p_value, fdr_corrected),
        _effect_size_label(abs_diff) + f"（差の大きさ: 約{pct:.2f}ポイント）",
        f"シグナルあり{n_signaled:,}件・ベースライン{n_baseline:,}件のデータに基づきます。",
    ]
    if low_sample:
        detail_parts.append("⚠ サンプル数が少なく、結果が偶然に左右されている可能性があります。")
    if large_sample and is_significant and not is_meaningful_effect:
        detail_parts.append(
            "⚠ サンプル数が非常に多いため、統計的には「有意」と判定されていますが、"
            "実際の差はごくわずかです。大標本ではわずかな差でも有意と出やすいという"
            "統計的な性質によるものであり、実務上の投資判断としての重要性は低いと考えられます。"
        )
    detail = " ".join(detail_parts)

    return PlainExplanation(verdict=verdict, headline=headline, detail=detail)


def annotate_dataframe(df, diff_column: str = "diff", fdr_column: str = "p_adj_fdr",
                        fdr_corrected: bool = True):
    """DataFrameの各行に対して explain_result() を適用し、"verdict"・"plain_summary" 列を追加した
    コピーを返す（元のDataFrame・既存列は変更しない。追加列のみのため既存の読み手には影響しない）。

    diff_column: フォワードリターン差にあたる列名。pooled/組み合わせ検定は "diff"、
                 daywise集計（summarize_daywise_ttest()の戻り値）は "mean_diff" を指定する。
    fdr_column: 有意性判定に使うp値の列名。daywise集計はFDR未補正の "p_value" を指定し、
                その場合は fdr_corrected=False とあわせて渡すことで、説明文に
                「多重検定補正なし」の注意書きが自動的に付与される。
    n_signaled/n_baseline に相当する列がない場合（daywise集計は "n_days" のみ）は、
    n_days をサンプル数の目安としてそのまま流用する（daywise集計は元々サンプル数が
    数百件規模〔=対象期間の営業日数〕のため、pooled検定のような数十万件規模を前提とした
    「大標本注意」が誤って出ることはない）。
    """
    import pandas as pd  # 関数内importとし、本モジュール単体の依存を最小限にする

    if df.empty:
        return df

    verdicts, headlines = [], []
    for _, row in df.iterrows():
        n_signaled = row["n_signaled"] if "n_signaled" in row else row.get("n_sig", row.get("n_days", 0))
        n_baseline = row["n_baseline"] if "n_baseline" in row else row.get("n_base", row.get("n_days", 0))
        explanation = explain_result(
            rule=row["rule"], diff=row[diff_column], p_value=row[fdr_column],
            n_signaled=n_signaled, n_baseline=n_baseline, fdr_corrected=fdr_corrected,
        )
        verdicts.append(explanation.verdict)
        headlines.append(explanation.headline)

    out = df.copy()
    out["verdict"] = verdicts
    out["plain_summary"] = headlines
    return out


def build_plain_report(pooled_df, daywise_summary_df, combo_df) -> str:
    """3種類の検定結果を統合し、非エンジニア向けの平易なレポート（テキスト）を生成する。

    「pooled・daywiseの両方で【有望】と判定された指標」を優先して先頭に示す方針とする
    （4083行目の記述の通り、daywise検定の方が市場全体の地合いの影響を受けにくく、
    より妥当な検定であるため。両方で裏付けが取れている指標ほど信頼度が高い）。
    """
    lines = []
    lines.append("=" * 70)
    lines.append("株式売買シグナル分析結果 - サマリーレポート（統計知識不要）")
    lines.append("=" * 70)
    lines.append("")
    lines.append("【このレポートの読み方】")
    lines.append("・【有望】：統計的な裏付けがあり、かつ実務的にも意味のありそうな差が見られた指標です。")
    lines.append("・【留意】：統計的には有意ですが、差そのものはごく小さく、実務上のインパクトは限定的です。")
    lines.append("・【参考】：偶然のばらつきと区別できず、根拠としては弱い指標です。")
    lines.append("")
    lines.append("【重要な注意点】")
    lines.append("・本レポートは過去データの統計的な傾向であり、将来の値動きを保証するものではありません。")
    lines.append("・heuristics_YYYYMMDD.json は当日の株式市場の大引け（取引終了）後に生成されるため、")
    lines.append("  「シグナル発生日の終値」を基準にした分析結果は、実際にはその価格で売買できません。")
    lines.append("  現実的な売買を検討する際は、シグナル発生「翌」営業日以降の価格を参照してください")
    lines.append("  （詳細は別途シミュレーション機能のドキュメントを参照）。")
    lines.append("")

    if not pooled_df.empty and "verdict" in pooled_df.columns:
        pooled_keys = set(pooled_df.loc[pooled_df["verdict"] == "【有望】", "rule"]
                           .apply(lambda r: r.split("=", 1)[0]))
    else:
        pooled_keys = set()
    if daywise_summary_df is not None and not daywise_summary_df.empty and "verdict" in daywise_summary_df.columns:
        daywise_keys = set(daywise_summary_df.loc[daywise_summary_df["verdict"] == "【有望】", "rule"])
    else:
        daywise_keys = set()
    both_significant = sorted(pooled_keys & daywise_keys)

    lines.append("【最も信頼度が高いと考えられる指標（pooled・daywiseの両方で【有望】）】")
    if both_significant:
        for key in both_significant:
            lines.append(f"  ・{key}")
    else:
        lines.append("  該当する指標はありませんでした。")
    lines.append("")

    lines.append("【pooled検定（銘柄横断のプール検定）の結果、上位10件】")
    if not pooled_df.empty and "plain_summary" in pooled_df.columns:
        for _, row in pooled_df.head(10).iterrows():
            lines.append(f"  {row['plain_summary']}")
    else:
        lines.append("  結果がありませんでした。")
    lines.append("")

    lines.append("【組み合わせ検定（複数TECH_*のAND条件）の結果】")
    if combo_df is not None and not combo_df.empty and "plain_summary" in combo_df.columns:
        for _, row in combo_df.head(10).iterrows():
            lines.append(f"  {row['plain_summary']}")
    else:
        lines.append("  有意な組み合わせは見つかりませんでした（候補が少ない、"
                      "または効果が確認できなかった可能性があります）。")
    lines.append("")
    lines.append("=" * 70)
    lines.append("詳細な数値は result_all.csv / result_daywise_summary.csv / "
                  "result_combinations.csv をご参照ください。")
    lines.append("=" * 70)

    return "\n".join(lines)
