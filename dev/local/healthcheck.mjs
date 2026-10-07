const response = await fetch(process.argv[2], { signal: AbortSignal.timeout(2_000) });
if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
