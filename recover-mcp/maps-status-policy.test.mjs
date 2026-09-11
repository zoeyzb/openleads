import test from "node:test";
import assert from "node:assert/strict";
import {
  mapsWaitBudgetMs,
  mapsStatusPollTimeoutMs,
  isTransientMapsStatusMessage,
} from "./maps-status-policy.mjs";

test("fast jobs wait longer than the backend 180-second minimum",()=>{
  assert.equal(mapsWaitBudgetMs({fastProfile:true,requestedMaxSeconds:60}),225000);
  assert.equal(mapsWaitBudgetMs({fastProfile:true,requestedMaxSeconds:180}),225000);
});

test("larger requested runtimes still receive the status grace window",()=>{
  assert.equal(mapsWaitBudgetMs({fastProfile:true,requestedMaxSeconds:240}),285000);
});

test("normal jobs preserve the existing twenty-minute budget",()=>{
  assert.equal(mapsWaitBudgetMs({fastProfile:false,requestedMaxSeconds:300}),1200000);
});

test("fast status polls fail quickly enough to retry inside the outer budget",()=>{
  assert.equal(mapsStatusPollTimeoutMs(true),10000);
  assert.equal(mapsStatusPollTimeoutMs(false),30000);
});

test("transient Railway/backend transport failures are retryable",()=>{
  for(const message of [
    "502 Bad Gateway",
    "503 Service Unavailable",
    "fetch failed",
    "network timeout",
    "socket hang up",
  ]) assert.equal(isTransientMapsStatusMessage(message),true,message);
  assert.equal(isTransientMapsStatusMessage("404 not found"),false);
  assert.equal(isTransientMapsStatusMessage("invalid job payload"),false);
});
