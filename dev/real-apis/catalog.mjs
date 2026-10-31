import { normalizeIntegrationManifest } from 'self-managed-api';

// Public documentation is real. Operations in this lab always use a simulated transport.
export const providers = Object.freeze([
  { id: 'stripe', name: 'Stripe', origin: 'https://api.stripe.com', path: '/v1/customers', method: 'GET',
    version: '2023-10-16', selector: 'request-header', selectorName: 'Stripe-Version',
    documentation: 'https://docs.stripe.com/upgrades', capture: 'https://raw.githubusercontent.com/stripe/stripe-node/master/README.md',
    change: 'A pinned request version and the webhook version must be reviewed separately; a newer SDK alone is not migration evidence.' },
  { id: 'paypal', name: 'PayPal', origin: 'https://api-m.paypal.com', path: '/v1/payments/payment', method: 'POST',
    version: 'v1', selector: 'endpoint', documentation: 'https://developer.paypal.com/api/rest/deprecated-resources/',
    change: 'Legacy Payments and Orders v2 have different workflows. Require a business decision before rewriting payment creation.' },
  { id: 'amazon-sp-api', name: 'Amazon SP-API', origin: 'https://sellingpartnerapi-eu.amazon.com', path: '/catalog/v0/items/DEMOASIN', method: 'GET',
    version: 'v0', selector: 'endpoint', documentation: 'https://developer-docs.amazon.com/sp-api/docs/sp-api-release-notes',
    capture: 'https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/catalog-items-api-model/catalogItems_2022-04-01.json',
    change: 'Catalog Items migration changes versioned paths, marketplace selection and response mapping. The source uses Swagger 2, not supported OpenAPI 3 input.' },
  { id: 'github', name: 'GitHub', origin: 'https://api.github.com', path: '/repos/octocat/Hello-World', method: 'GET',
    version: '2022-11-28', selector: 'request-header', selectorName: 'X-GitHub-Api-Version',
    documentation: 'https://docs.github.com/en/rest/about-the-rest-api/api-versions',
    change: 'Version selection, release changes and support dates are separate evidence. An older version is not automatically retired.' },
  { id: 'slack', name: 'Slack', origin: 'https://slack.com', path: '/api/files.upload', method: 'POST',
    version: null, selector: 'unknown', documentation: 'https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay/',
    change: 'Retired files.upload requires a multi-step upload workflow, not a simple endpoint substitution.' },
  { id: 'notion', name: 'Notion', origin: 'https://api.notion.com', path: '/v1/databases/00000000-0000-4000-8000-000000000001/query', method: 'POST',
    version: '2022-06-28', selector: 'request-header', selectorName: 'Notion-Version',
    documentation: 'https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03',
    change: 'The selected exercise migrates database queries to data source queries and requires an explicitly selected data_source_id.' },
  { id: 'shopify', name: 'Shopify', origin: 'https://self-managed-api-demo.myshopify.com', path: '/admin/api/2024-01/graphql.json', method: 'POST',
    version: '2024-01', selector: 'endpoint', documentation: 'https://shopify.dev/docs/api/usage/versioning',
    change: 'Check the effective response version and GraphQL selection set; matching only the HTTP path cannot prove compatibility.' },
  { id: 'twilio', name: 'Twilio', origin: 'https://api.twilio.com', path: '/2010-04-01/Accounts/ACDEMO/Messages.json', method: 'GET',
    version: '2010-04-01', selector: 'endpoint', documentation: 'https://www.twilio.com/docs/usage/api',
    change: 'A date in the endpoint is not proof of retirement. Changes in permissions and payloads still require review.' },
  { id: 'sendgrid', name: 'Twilio SendGrid', origin: 'https://api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
    version: 'v3', selector: 'endpoint', documentation: 'https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api',
    change: 'An authorization or required-payload change can matter without a versioned URL change. Never send real email from the lab.' },
  { id: 'discord', name: 'Discord', origin: 'https://discord.com', path: '/api/v10/users/@me', method: 'GET',
    version: 'v10', selector: 'endpoint', documentation: 'https://docs.discord.com/developers/reference',
    change: 'Observe version support, permissions and rate-limit behavior. No bot token or live message is needed for contract tests.' },
]);

export function providerManifest(provider) {
  return normalizeIntegrationManifest({ schemaVersion: 1, provider: provider.name, product: 'Local integration exercise',
    endpoints: [{ id: 'upstream', url: provider.origin, environment: 'documented-production-origin-not-contacted' }],
    sources: [
      { id: 'docs', kind: 'documentation', location: { type: 'https', url: provider.documentation }, provenance: 'documentation-claim', coverage: 'partial' },
      { id: 'consumer', kind: 'documentation', location: { type: 'local', path: `adapters/${provider.id}.mjs` }, provenance: 'observed-behavior', coverage: 'partial' },
    ],
    knownVersions: provider.version === null ? [] : [{ id: 'configured', axis: 'api', value: provider.version, sourceIds: ['consumer'] }],
    effectiveVersions: [{ axis: 'api', value: provider.version, selector: provider.selector,
      ...(provider.selectorName ? { selectorName: provider.selectorName } : {}), endpointId: 'upstream', sourceIds: provider.version === null ? [] : ['consumer'] }],
    boundaries: [{ id: provider.id, requirements: [{ id: 'review', kind: 'business-decision', description: provider.change, sourceIds: ['docs'] }] }],
  });
}
