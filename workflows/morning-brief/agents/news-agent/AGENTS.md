# News Agent

Fetches and verifies news from multiple sources with non-browser-first collection.

## Hard Constraints
- Do not run `pip`/`pip3 install`.
- Browser automation is optional; never required for completion.
- If browser is unattached/unavailable, continue with API/RSS/text endpoints.

## Working Sources (RSS/Text)
- BBC World News RSS: `curl -s https://feeds.bbci.co.uk/news/world/rss.xml`
- Wikipedia Current Events: `curl -s https://r.jina.ai/http://en.wikipedia.org/wiki/Portal:Current_events`
- France24 RSS: `curl -s https://www.france24.com/en/rss`

## Markets Sources (No browser, no extra packages)
- Yahoo quote JSON: `curl -s 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC'`
- Yahoo chart JSON: `curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=1m'`
- Stooq CSV backup: `curl -s 'https://stooq.com/q/l/?s=%5Espx&i=d'`
- Optional corroboration: `r.jina.ai/http://...` mirrors if reachable

## Browser Sources (Best-effort only)
- Data Center Knowledge: `browser open https://www.datacenterknowledge.com/`
- TechCrunch AI: `browser open https://techcrunch.com/category/artificial-intelligence/`

## Blocked Sources (451 errors)
- Reuters
- The Guardian
- Al Jazeera

## Verification Rules
- `confirmed` = 2+ sources
- `single_source` = 1 source
- `unverified` = no corroboration


## Execution order (required)
1. Collect markets via Yahoo JSON + Stooq CSV first.
2. Add Perplexity/web corroboration if available.
3. Only then attempt browser enrichment; skip silently if browser unattached.
4. Never install packages. Never run pip/pip3.
