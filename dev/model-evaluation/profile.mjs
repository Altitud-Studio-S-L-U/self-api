// Public upstream revisions only. Downloading weights is an explicit lab setup
// step; this module is never imported by the SDK or worker.
import { join } from 'node:path';
export const profile = Object.freeze({
  model: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M',
  modelRepository: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
  revision: 'f86cb2c1fa58255f8052cc32aeede1b7482d4361',
  filename: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
  sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
  byteLength: 1117320768,
  license: 'Apache-2.0',
  serverImage: 'ghcr.io/ggml-org/llama.cpp@sha256:a48c794aabc51dc5f9663c358b946b79d4cc02de67ab4d508c2c850fd0bc20f8',
  serverRevision: 'f498f864fbc0472004ee1c3616c1188c68eb157f',
  nodeImage: 'node@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd',
});

export const profiles = Object.freeze({
  '1.5b': profile,
  '7b': Object.freeze({ ...profile,
    model: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M',
    modelRepository: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
    revision: '13fb94bfda8c8cf22497dc57b78f391a9acb426a',
    filename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
    sha256: '509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c',
    byteLength: 4683073536,
  }),
});
export function selectProfile(name = '1.5b') {
  if (!Object.hasOwn(profiles, name)) throw new Error('Select the pinned 1.5b or 7b model profile; there is no fallback.');
  return profiles[name];
}
export function modelFile(root, name) {
  const selected = selectProfile(name);
  return name === '7b' ? join(root, 'work/models/qwen-7b', selected.filename)
    : join(root, 'work/model-evaluation/models', selected.filename);
}
