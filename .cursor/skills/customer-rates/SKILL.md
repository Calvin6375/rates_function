---
name: customer-rates
description: >-
  TruePay KES-numeraire customer rates, canonical currency keys, Send/Get
  quotes, locked exchangeQuotes, settlement capability. Use for customerRates,
  /customer-rates, /rates, /config/fees, createSwapOrder quoteId.
---

# Customer rates (KES book)

## Invariant

Every canonical rate = **KES per 1 unit**. Cross: `KES_send / KES_get`.  
Never interpret as units-per-USDT. Never silent 1.0 peg.

## Storage

- **Write:** currency keys only (`ETB`) + optional explicit `ETB/USDC` overrides  
- **Read:** also accept legacy `USDT/ETB` / `ETB/KES` (canonical wins on conflict)  
- `rateVersion` increments on admin save

## Quotes

`GET /customer-rates?send&get&sendAmount` or `POST /exchange-quotes` → `quoteId`  
`createSwapOrder({ quoteId })` uses locked amounts — no live re-price.

## Capability

`settlementCapabilityService` — separate from rate math. Swap ledger: USDT/USD/KES.

## Supported list

`GET /countries` → currency codes from the rates book (`currencies` + legacy `countries`).  
Writes: `PUT /api/config/fees` only. `setSupportedCountries` is rejected.

## Docs

`docs/rates.md`
