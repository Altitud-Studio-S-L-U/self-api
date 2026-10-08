// Pilot baseline deliberately accepts GitHub's older directory-entry types.
export function parseEntries(body) {
  if (!Array.isArray(body)) throw new Error('Invalid contents response');
  return body.map(entry => {
    if (!entry || typeof entry.path !== 'string' || !['file', 'dir'].includes(entry.type)
      || typeof entry.html_url !== 'string') throw new Error('Unsupported contents entry');
    return { path: entry.path, directory: entry.type === 'dir',
      downloadable: entry.type === 'file' && typeof entry.download_url === 'string' };
  });
}

export async function listRepository() {
  const response = await fetch('https://api.github.com/repos/git/git/contents?ref=master', {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Contents request failed');
  return parseEntries(await response.json());
}
