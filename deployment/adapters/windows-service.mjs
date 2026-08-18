// ---------------------------------------------------------------------------
// adapters/windows-service.mjs — the Windows Server mechanics.
//
// WHY THIS EXISTS NOW. The core has always derived `windows-service` from
// `hosting.os=windows` (manifest.mjs). Until now no adapter answered to that
// name, so a Windows manifest produced a blocker instead of a plan. Lippolis
// named the target — LIPELE-RDS02, Windows Server 2019 Standard, Hyper-V — so
// the mechanics are now a known environment rather than a guess.
//
// UNPROVEN UNTIL IT IS PROVEN. `proven: false` below is load-bearing. No PCC
// installation has completed on Windows yet, and the deployment core reads this
// flag rather than assuming that having an adapter means having a deployment.
// Flip it in the same change that records the first successful install, not
// before.
//
// WHAT IT TRANSLATES, AND WHAT IT REFUSES TO INVENT
//
// The Linux adapter's one non-obvious line is `RestartPreventExitStatus=1`: a
// deliberate configuration refusal exits 1, and restarting a refusal is a loop
// that buries the single line explaining what is wrong. That behaviour is the
// most important thing to carry across, and it is why this adapter supervises
// with NSSM rather than with a Scheduled Task. NSSM's `AppExit 1 Exit` /
// `AppExit Default Restart` pair is an exact translation. Task Scheduler can
// restart on failure but cannot distinguish a crash from a refusal, so a
// misconfigured PCC would restart forever and look like a flapping service
// instead of a stopped one with a readable reason.
//
// NSSM IS A THIRD-PARTY BINARY and Jose has to approve it landing on RDS02.
// That is a real cost, stated here rather than buried: it is one signed
// executable, no installer, no service of its own. If it is refused, the native
// fallback is a Scheduled Task with an At-Startup trigger, and the cost of that
// choice is the refusal semantics above.
//
// NOTHING HERE RUNS. Like the Linux adapter, this returns text and command
// lists for a human with Administrator rights to read and execute.
// ---------------------------------------------------------------------------

export const windowsService = {
  id: 'windows-service',
  os: 'windows',

  /**
   * No PCC installation has completed on Windows yet.
   *
   * The Linux adapter earned its confidence from a deployment that happened.
   * This one has a confirmed target and no completed install, and the
   * difference should be visible to anything that reads adapters rather than
   * inferred from which files exist.
   */
  proven: false,

  /**
   * Conventions AWE offers when the manifest does not say. Defaults, not law.
   *
   * ProgramData rather than Program Files for anything written at runtime:
   * Program Files is read-only for non-administrators by design, and putting a
   * SQLite database there produces a permission failure at the first write
   * rather than at install time, which is the worst moment to discover it.
   *
   * The service account is a virtual account — `NT SERVICE\pcc` — which Windows
   * creates with the service, gives no password, no interactive logon and no
   * network identity. It is the closest Windows equivalent to the Linux
   * adapter's `--system --shell /usr/sbin/nologin` account, and it needs no
   * credential from IT.
   */
  defaults: {
    install_path: 'C:\\Program Files\\{app}',
    data_path: 'C:\\ProgramData\\{app}\\data',
    secrets_store: 'C:\\ProgramData\\{app}\\{app}.env',
    service_user: 'NT SERVICE\\{app}',
    port: 3000,
  },

  /**
   * The service definition, as the PowerShell that creates it.
   *
   * Windows has no unit file. The nearest honest equivalent is the exact,
   * re-runnable sequence that puts the service into the intended state, which
   * is what this returns — reviewable before it is run, and diffable when it
   * changes.
   *
   * `AppExit 1 Exit` is the whole point; see the header.
   */
  unit({ app, description, installPath, dataPath, secretsStore, user, start }) {
    return `# ${description}
# Creates the "${app}" Windows service. Run as Administrator.
# Re-runnable: every setting is assigned, not appended.

$ErrorActionPreference = 'Stop'

# The supervised command. PCC is a plain Node process listening on a port.
nssm install ${app} "${start}"
nssm set ${app} AppDirectory "${installPath}"
nssm set ${app} DisplayName "${description}"
nssm set ${app} Description "${description}"
nssm set ${app} Start SERVICE_AUTO_START

# The virtual service account. No password exists to rotate or leak.
nssm set ${app} ObjectName "${user}"

# Configuration comes from a file outside the install path, exactly as the
# Linux adapter's EnvironmentFile does. NSSM reads NAME=VALUE lines.
nssm set ${app} AppEnvironmentExtra "PCC_ENV_FILE=${secretsStore}"

# Crashes restart; deliberate refusals do not. A configuration refusal exits 1,
# and restarting it would bury the one line that says what is wrong.
nssm set ${app} AppExit Default Restart
nssm set ${app} AppExit 1 Exit
nssm set ${app} AppRestartDelay 5000
nssm set ${app} AppThrottle 300000

# Windows has no journal. Without this, stdout goes nowhere and a failed start
# is silent. Rotation is set here because nothing else will do it.
nssm set ${app} AppStdout "${dataPath}\\..\\logs\\${app}.out.log"
nssm set ${app} AppStderr "${dataPath}\\..\\logs\\${app}.err.log"
nssm set ${app} AppRotateFiles 1
nssm set ${app} AppRotateOnline 1
nssm set ${app} AppRotateBytes 10485760

nssm start ${app}
`;
  },

  /**
   * The install plan, as text. Nothing here runs.
   *
   * The icacls lines are this adapter's `install -d -o pcc -g pcc -m 750`. The
   * service account gets write access to the data directory and read access to
   * the secrets file, and nothing else on the machine.
   */
  installPlan({ app, installPath, dataPath, secretsStore, user }) {
    const logPath = `${dataPath}\\..\\logs`;
    return [
      `New-Item -ItemType Directory -Force -Path "${installPath}", "${dataPath}", "${logPath}"`,
      `Copy-Item -Recurse -Force <build-artifact>\\* "${installPath}\\"`,
      `New-Item -ItemType File -Force -Path "${secretsStore}"   # then fill it in`,
      `# The service account is created by nssm/sc with the service itself; these`,
      `# grants are what it may touch. Everything else stays denied by default.`,
      `icacls "${dataPath}" /grant "${user}:(OI)(CI)M" /inheritance:r /grant "Administrators:(OI)(CI)F"`,
      `icacls "${logPath}"  /grant "${user}:(OI)(CI)M" /inheritance:r /grant "Administrators:(OI)(CI)F"`,
      `icacls "${secretsStore}" /grant "${user}:R" /inheritance:r /grant "Administrators:F"`,
      `# Read-only for the service: it must not be able to rewrite its own code.`,
      `icacls "${installPath}" /grant "${user}:(OI)(CI)RX"`,
      `powershell -ExecutionPolicy Bypass -File .\\install-${app}-service.ps1   # the unit text above`,
    ];
  },

  /** Commands that PROVE the service is installed and will survive a reboot. */
  verificationCommands(app) {
    return {
      SERVICE_RUNNING: `(Get-Service ${app}).Status`,
      SERVICE_ENABLED_AT_BOOT: `(Get-Service ${app}).StartType   # expect: Automatic`,
      REBOOT_RECOVERY_SUCCEEDED: `Restart-Computer   # then: (Get-Service ${app}).Status`,
      logs: `Get-Content "C:\\ProgramData\\${app}\\logs\\${app}.err.log" -Tail 50`,
    };
  },
};
