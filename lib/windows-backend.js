/** Deprecated import kept for existing downstream integrations. */
export {
  PlatformBackend as WindowsBackend, PlatformBackend,
  managedPaths, ensureManagedFiles, downloadAsset, runCommand,
  validatePort, checkPortFree, resolvePlatform, detectLinuxLibc,
  SOURCE_COMMIT, UV_VERSION, SOURCE_URL, DEFAULT_PORT
} from './platform-backend.js';
