#!/usr/bin/env node
/**
 * Antigravity `Stop` hook -> Scoped Skill Delivery Contract Gate.
 *
 * Guarantees:
 *   1. Scoped strictly to THIS plugin's role skills (`<slug>-planner`, `<slug>-producer`, `<slug>-verifier`).
 *      Unrelated conversations and other Swarm plugins exit immediately with `{}`.
 *   2. Blocks AT MOST ONCE per turn (`continuationActive` check + per-turn state file).
 *   3. Never blocks mid-question turns, `ask_question` / `swarm_wait` pauses, or BLOCKED/NEEDS_INPUT states.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pluginSlug, sanitizeId, stateRoot } from './lib-swarm-scope.mjs';

/**
 * Delivery contract checks keyed by role suffix (`<plugin-slug>-<suffix>`).
 * Customize these regexes for your own domain's mandatory evidence / verdict format!
 */
const ROLE_CONTRACTS = {
  planner: {
    check: (text) => /PLAN_STATUS:\s*(READY|NEEDS_INPUT)/i.test(text) && /ownership\.json/i.test(text),
    missingReason: (skillName) =>
      `DELIVERY_CONTRACT_UNMET (${skillName}): Before finishing, include explicit "PLAN_STATUS: READY" (or NEEDS_INPUT) and confirm the paths to your spec and ownership.json manifest.`,
  },
  producer: {
    check: (text) => /DELIVERABLE_STATUS:\s*(READY_FOR_AUDIT|REVISED|BLOCKED)/i.test(text),
    missingReason: (skillName) =>
      `DELIVERY_CONTRACT_UNMET (${skillName}): Before finishing, include "DELIVERABLE_STATUS: READY_FOR_AUDIT" (or REVISED/BLOCKED), output file paths, and a brief self-check summary.`,
  },
  verifier: {
    check: (text) => /VERDICT:\s*(PASS|REVISE)/i.test(text),
    missingReason: (skillName) =>
      `DELIVERY_CONTRACT_UNMET (${skillName}): Before finishing, include an explicit "VERDICT: PASS" or "VERDICT: REVISE" along with structured evidence and your audit report path.`,
  },
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function evaluateStopContract(payload) {
  if (
    payload?.continuationActive === true ||
    payload?.terminationReason !== 'NO_TOOL_CALL' ||
    payload?.fullyIdle === false
  ) {
    return {};
  }

  const transcriptPath = payload?.transcriptPath;
  const convId = payload?.conversationId || 'unknown';
  if (typeof transcriptPath !== 'string' || !fs.existsSync(transcriptPath)) {
    return {};
  }

  const rawLines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').filter(Boolean);
  const steps = [];
  let lastUserIdx = -1;
  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      steps.push(obj);
      if (obj.type === 'USER_INPUT') {
        lastUserIdx = steps.length - 1;
      }
    } catch {
      /* skip malformed line */
    }
  }

  // If a Swarm worker turn began via board message without USER_INPUT, inspect from step 0
  const turnSteps = lastUserIdx >= 0 ? steps.slice(lastUserIdx + 1) : steps;
  const slug = pluginSlug();
  const skillPathRe = new RegExp(`[/\\\\]skills[/\\\\](${escapeRegExp(slug)}-([a-z0-9-]+))[/\\\\]SKILL\\.md$`, 'i');

  let loadedSkill = null;
  let loadedRoleSuffix = null;
  let lastPlannerText = '';
  const allTexts = [];

  for (const st of turnSteps) {
    if (typeof st.content === 'string' && st.content) {
      allTexts.push(st.content);
      if (st.type === 'PLANNER_RESPONSE') lastPlannerText = st.content;
    }
    if (Array.isArray(st.tool_calls)) {
      for (const tc of st.tool_calls) {
        const tName = tc?.name || '';
        if (tName === 'ask_question' || tName === 'swarm_wait') {
          return {};
        }
        const p = tc?.args?.Path || tc?.arguments?.Path || '';
        if (typeof p === 'string') {
          const m = skillPathRe.exec(p);
          if (m) {
            loadedSkill = m[1].toLowerCase();
            loadedRoleSuffix = m[2].toLowerCase();
          }
        }
      }
    }
  }

  if (!loadedSkill || !loadedRoleSuffix || !Object.hasOwn(ROLE_CONTRACTS, loadedRoleSuffix)) {
    return {};
  }

  const trimmedLast = lastPlannerText.trim();
  if (
    !trimmedLast ||
    trimmedLast.endsWith('?') ||
    trimmedLast.endsWith('？') ||
    /NEEDS_INPUT|STATUS:\s*BLOCKED/i.test(trimmedLast)
  ) {
    return {};
  }

  const gateDir = path.join(stateRoot(), 'stop-gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const recordFile = path.join(gateDir, `${sanitizeId(convId)}.json`);
  let rec = {};
  try {
    rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  } catch {
    rec = {};
  }

  const turnKey = `${lastUserIdx}:${loadedSkill}`;
  if (rec[turnKey]) {
    return {};
  }

  const combined = allTexts.join('\n');
  const contract = ROLE_CONTRACTS[loadedRoleSuffix];
  if (contract.check(combined)) {
    rec[turnKey] = 'met';
    fs.writeFileSync(recordFile, JSON.stringify(rec, null, 2));
    return {};
  }

  rec[turnKey] = 'blocked_once';
  fs.writeFileSync(recordFile, JSON.stringify(rec, null, 2));
  return {
    decision: 'continue',
    reason: `${contract.missingReason(loadedSkill)} (This gate blocks at most once per turn.)`,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(raw || '{}');
      const result = evaluateStopContract(payload);
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch {
      process.stdout.write('{}\n');
    }
  });
}
