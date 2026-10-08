/**
 * Provider connectivity + structured-output self-check.
 *
 * Usage:
 *   npm run provider:check                 # checks the provider routed for 'conversation'
 *   npm run provider:check nvidia-nim      # forces a specific provider id from your config
 *
 * What it does:
 *   1. Loads your config (config/ideno.config.json or $IDENO_CONFIG).
 *   2. Prints redacted provider info and any configuration problems.
 *   3. Runs a health check (GET /models).
 *   4. Lists models and warns if the configured model is not among them.
 *   5. Runs a REAL structured-output round trip using the same envelope
 *      schema as a normal Ideno turn (routing, negotiation, validation and
 *      the bounded repair pass are all exercised).
 *
 * Secrets are read from the environment (api_key_env) — never from files.
 *
 * Exit codes: 0 ok, 1 usage/config error, 2 health failed, 3 round trip failed.
 */
import { loadConfig, buildProviders } from '../src/server/config/load.js';
import { AIRuntime } from '../src/server/ai/runtime.js';
import { OrchestratorEnvelope } from '../src/shared/schemas/proposal.js';
import { buildEnvelopeWireSchema } from '../src/server/ai/wireSchema.js';

const CHECK_SYSTEM =
  'You are a connectivity checker for Ideno. Respond with a single JSON object of the form {"reply": "<short confirmation text>"}. No prose, no code fences.';

async function main(): Promise<void> {
  const targetId = process.argv[2];
  const { config, configPath } = await loadConfig();
  const providers = buildProviders(config, process.env);

  let target: string;
  if (targetId) {
    if (!providers.has(targetId)) {
      console.error(`Provider '${targetId}' is not defined in ${configPath}.`);
      console.error(`Defined providers: ${[...providers.keys()].join(', ') || '(none)'}`);
      process.exit(1);
    }
    target = targetId;
  } else {
    const routed = config.routing.conversation?.provider;
    if (!routed) {
      console.error("No routing entry for 'conversation' — pass a provider id explicitly.");
      process.exit(1);
    }
    target = routed;
  }

  const provider = providers.get(target);
  if (!provider) {
    console.error(`Provider '${target}' could not be constructed.`);
    process.exit(1);
  }

  console.log(`Provider:  ${provider.id} (${provider.displayName})`);
  console.log(`Model:     ${provider.model}`);
  console.log(
    `Privacy:   ${provider.capabilities.privacy}${provider.capabilities.is_demo ? '  [DEMO — scripted, not AI]' : ''}`,
  );
  console.log(`Config:    ${configPath}`);
  console.log(`Mode:      privacy_mode=${config.privacy_mode}`);
  console.log('');

  const problems = provider.validateConfiguration();
  if (problems.length > 0) {
    console.log('Configuration problems:');
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log('Configuration: OK');
  }

  console.log('');
  console.log('Health check…');
  const health = await provider.healthCheck(10_000);
  console.log(
    `  ${health.ok ? 'OK' : 'FAILED'} — ${health.detail}${health.latencyMs !== undefined ? ` (${health.latencyMs}ms)` : ''}`,
  );
  if (!health.ok) process.exit(2);

  try {
    const models = await provider.listModels();
    const sample = models.slice(0, 3).join(', ');
    console.log(
      `  Models listed: ${models.length}${sample ? ` (e.g. ${sample}${models.length > 3 ? ', …' : ''})` : ''}`,
    );
    if (provider.model && models.length > 0 && !models.includes(provider.model)) {
      console.log(
        `  ⚠ configured model '${provider.model}' is NOT in the listed models — requests may fail with 404. Use an exact id from the catalog.`,
      );
    }
  } catch (err) {
    console.log(`  Model listing unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log('');
  console.log('Structured-output round trip (production envelope schema)…');
  const runtime = new AIRuntime(providers, {
    privacy_mode: config.privacy_mode,
    routing: { conversation: { provider: target, fallbacks: [] } },
  });
  try {
    const result = await runtime.runStructured<OrchestratorEnvelope>({
      task: 'conversation',
      system: CHECK_SYSTEM,
      messages: [{ role: 'user', content: 'Connectivity check — reply with the JSON object now.' }],
      schemaName: 'ideno_connectivity_check',
      zodSchema: OrchestratorEnvelope,
      wireSchema: buildEnvelopeWireSchema(),
      temperature: 0,
      timeoutMs: 60_000,
      noStream: true,
    });
    console.log(`  OK via ${result.providerId}/${result.model}`);
    console.log(
      `  structured output mode: ${result.mode}${result.repairAttempts > 0 ? ` (needed ${result.repairAttempts} repair pass)` : ''}`,
    );
    console.log(`  reply: ${JSON.stringify(result.value.reply.slice(0, 120))}`);
    if (result.usage) {
      console.log(`  usage: in=${result.usage.input_tokens ?? '?'} out=${result.usage.output_tokens ?? '?'}`);
    }
    console.log('');
    console.log(
      provider.capabilities.is_demo
        ? 'Demo provider responded (scripted) — this verifies the plumbing, not real AI.'
        : 'Real provider round trip verified end-to-end.',
    );
    if (result.mode !== 'json_schema') {
      console.log(
        `Note: mode is '${result.mode}' — the model's output is validated (and repaired once) by Ideno rather than guaranteed by the endpoint. If the endpoint supports json_schema, set structured_output: "json_schema" for stricter guarantees.`,
      );
    }
    process.exit(0);
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    const detail = (err as { detail?: string[] }).detail;
    if (Array.isArray(detail)) {
      for (const d of detail) console.log(`    - ${d}`);
    }
    process.exit(3);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
