/**
 * Pure-function tests for the BSK-005 brain bridge (GROW-BIND-4).
 *
 * Uses Node's built-in `node --test` runner — no external deps.
 *
 * Run from agents/cod_confirm/:
 *   node --test test/brain.test.js
 *
 * The tests below DO NOT actually execute in this lane's CI because
 * @modelcontextprotocol/sdk isn't installed yet (no `pnpm install`
 * has run in agents/cod_confirm/ since the MONO-5 import). Once
 * deps install, the suite runs as-is. See the GROW-BIND-4 VF for
 * the explicit scope deferral.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  slugToEnvSuffix,
  brainAvailableFor,
} from "../src/lib/brain.js";

// Each test wipes the BSK-005 env vars first to ensure isolation.
function clearBrainEnv() {
  for (const key of Object.keys(process.env)) {
    if (key === "BRAIN_TOKEN_BSK_005" || key.startsWith("BRAIN_TOKEN_BSK_005_")) {
      delete process.env[key];
    }
  }
}

test("slugToEnvSuffix: kebab → UPPER_SNAKE", () => {
  assert.equal(slugToEnvSuffix("glitch-executor"), "GLITCH_EXECUTOR");
});

test("slugToEnvSuffix: snake → UPPER_SNAKE", () => {
  // Some call sites pass shop names in snake form.
  assert.equal(slugToEnvSuffix("glitch_executor"), "GLITCH_EXECUTOR");
});

test("slugToEnvSuffix: case-insensitive on input", () => {
  assert.equal(slugToEnvSuffix("Ayurpet"), "AYURPET");
});

test("slugToEnvSuffix: trims whitespace", () => {
  assert.equal(slugToEnvSuffix("  ayurpet  "), "AYURPET");
});

test("slugToEnvSuffix: null/empty/undefined → null", () => {
  assert.equal(slugToEnvSuffix(null), null);
  assert.equal(slugToEnvSuffix(""), null);
  assert.equal(slugToEnvSuffix(undefined), null);
});

test("slugToEnvSuffix: invalid chars stripped", () => {
  assert.equal(slugToEnvSuffix("foo$bar"), "FOOBAR");
});

test("brainAvailableFor: false when nothing set", () => {
  clearBrainEnv();
  assert.equal(brainAvailableFor("glitch-executor"), false);
});

test("brainAvailableFor: true when per-brand set", () => {
  clearBrainEnv();
  process.env.BRAIN_TOKEN_BSK_005_GLITCH_EXECUTOR = "gbm_per_brand";
  try {
    assert.equal(brainAvailableFor("glitch-executor"), true);
  } finally {
    clearBrainEnv();
  }
});

test("brainAvailableFor: true when only legacy set", () => {
  clearBrainEnv();
  process.env.BRAIN_TOKEN_BSK_005 = "gbm_legacy";
  try {
    assert.equal(brainAvailableFor("ayurpet"), true);
  } finally {
    clearBrainEnv();
  }
});

test("brainAvailableFor: false for unknown brand when only OTHER brand has token", () => {
  // Per-brand isolation: a token for one brand must NOT enable mirror
  // for another. cod_confirm is single-brand today (only
  // glitch-executor) but the design is multi-brand-ready.
  clearBrainEnv();
  process.env.BRAIN_TOKEN_BSK_005_AYURPET = "gbm_ayurpet";
  try {
    assert.equal(brainAvailableFor("glitch-executor"), false);
  } finally {
    clearBrainEnv();
  }
});
