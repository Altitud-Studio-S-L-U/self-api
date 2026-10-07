# Fictional Orders API migration

This is controlled test evidence, not a real provider announcement.

In fixture version 2026-02-01, `amount` replaces `total` with exactly the same numeric value, currency units, and business meaning. The application's internal `Order.total` remains unchanged.

Requests now require a `region` query parameter. The fixture consumer already receives the applicable region as `context.region`; forward that value without inventing a default. The recipe explicitly records both decisions. With either decision absent, Plumber must report a requirement rather than prepare a ready proposal.
