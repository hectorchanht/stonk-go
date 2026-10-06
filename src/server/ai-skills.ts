import type { AiLocale } from "~/server/ai";

/**
 * Skills are prompt fragments the user can load into the AI's system
 * prompt. Each skill has per-locale text. The chat UI lets the user
 * toggle them; the server only ever selects from this allowlist.
 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** On by default for new users. */
  defaultOn: boolean;
  prompt: Record<AiLocale, string>;
}

export const SKILLS: Skill[] = [
  {
    id: "teacher",
    name: "Teacher",
    description: "Explains jargon and concepts in plain language",
    defaultOn: false,
    prompt: {
      en: "You are also a patient teacher. When you use investing jargon (P/E, cost basis, concentration risk…), add a one-line plain-language explanation the first time.",
      "zh-Hant":
        "你同時係個有耐性嘅老師。用到投資術語（市盈率、成本價、集中風險…）嗰陣，第一次要用一句大白話解釋。",
      "zh-Hans":
        "你同时是一位耐心的老师。用到投资术语（市盈率、成本价、集中风险……）时，第一次用一句大白话解释。",
    },
  },
  {
    id: "risk",
    name: "Risk manager",
    description: "Focuses on downside, concentration and what could go wrong",
    defaultOn: false,
    prompt: {
      en: "You think like a risk manager. In every answer, flag the single biggest risk you see in the data — concentration, a stretched position, downside exposure — in one crisp sentence.",
      "zh-Hant":
        "你用風險經理嘅腦諗嘢。每個答案都要用一句精簡嘅說話，指出數據入面最大嘅風險 — 集中度、估值太貴、下行風險。",
      "zh-Hans":
        "你用风险经理的脑子想问题。每个回答都要用一句精炼的话，指出数据里最大的风险——集中度、估值太贵、下行风险。",
    },
  },
  {
    id: "tax",
    name: "Tax-aware",
    description: "Flags tax implications (not tax advice)",
    defaultOn: false,
    prompt: {
      en: "You flag tax implications where relevant (e.g. selling a winner realizes gains, holding period matters). You are not a tax advisor — say that once, briefly, when it first comes up.",
      "zh-Hant":
        "相關嘅時候你會提稅務影響（例如賣贏家會實現利得、持有期有影響）。你唔係稅務顧問 — 第一次提到嗰陣簡單講一句就得。",
      "zh-Hans":
        "相关时你会提示税务影响（例如卖出赢家会实现利得、持有期有影响）。你不是税务顾问——第一次提到时简单说一句即可。",
    },
  },
];

export function normalizeSkills(v: unknown): string[] {
  if (!Array.isArray(v)) return SKILLS.filter((s) => s.defaultOn).map((s) => s.id);
  const ids = new Set(SKILLS.map((s) => s.id));
  return v.filter((x): x is string => typeof x === "string" && ids.has(x));
}
