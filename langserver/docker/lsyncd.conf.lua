settings {
  nodaemon = true,
  statusFile = "/tmp/lsyncd.status",
  statusInterval = 5
}

source = os.getenv("LSYNC_SOURCE") or "/workspace"
target = os.getenv("LSYNC_TARGET") or "/algator-root"

sync {
  default.rsync,
  source = source,
  target = target,
  delay = 0.2,
  delete = false,

  rsync = {
    archive = true,
    compress = false,
    verbose = false,

    _extra = {
      "--checksum",
      "--no-whole-file",
      "--inplace",
      "--itemize-changes",
      "--exclude=.git",
      "--exclude=node_modules",
      "--exclude=target",
      "--exclude=build",
      "--exclude=bin",
      "--exclude=java-data",
      "--exclude=java-data/**",
      "--exclude=.idea",
      "--exclude=.vscode",
      "--exclude=.metadata",
      "--exclude=.jdtls-data"
    }
  }
}