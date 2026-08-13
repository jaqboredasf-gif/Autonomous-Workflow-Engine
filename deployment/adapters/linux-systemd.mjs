// ---------------------------------------------------------------------------
// adapters/linux-systemd.mjs — the one adapter with a real deployment behind it.
//
// Everything here was learned from PCC's units in deploy/. The adapter's job is
// to turn manifest facts into the commands and the unit an operator runs; it
// makes no decisions about readiness, blockers or evidence.
//
// IT RETURNS COMMANDS AS TEXT AND EXECUTES NOTHING. Generating a plan and
// running it are different operations, and a module that can do both will
// eventually be asked to do the second one against production by somebody who
// wanted the first.
// ---------------------------------------------------------------------------

export const linuxSystemd = {
  id: 'systemd',
  os: 'linux',

  /** Conventions AWE offers when the manifest does not say. Defaults, not law. */
  defaults: {
    install_path: '/opt/{app}',
    data_path: '/var/lib/{app}',
    secrets_store: '/etc/{app}.env',
    service_user: '{app}',
    port: 3000,
  },

  /**
   * The unit file.
   *
   * The one non-obvious line is `RestartPreventExitStatus=1`. A deliberate
   * configuration refusal exits 1, and restarting that is a loop that fills the
   * journal and buries the single line explaining what is wrong. Crashes
   * restart; refusals stop and stay stopped.
   */
  unit({ app, description, installPath, dataPath, secretsStore, user, start }) {
    return `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${installPath}
EnvironmentFile=${secretsStore}
ExecStart=${start}

Restart=on-failure
RestartPreventExitStatus=1
RestartSec=5s
StartLimitBurst=5
StartLimitIntervalSec=300

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${app}

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${dataPath}
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
`;
  },

  /** The install plan, as text. Nothing here runs. */
  installPlan({ app, installPath, dataPath, secretsStore, user }) {
    return [
      `sudo useradd --system --home ${installPath} --shell /usr/sbin/nologin ${user}`,
      `sudo install -d -o ${user} -g ${user} -m 750 ${dataPath}`,
      `sudo install -o root -g ${user} -m 640 /dev/null ${secretsStore}   # then fill it in`,
      `sudo rsync -a <build-artifact>/ ${installPath}/ && sudo chown -R ${user}:${user} ${installPath}`,
      `sudo cp <unit-file> /etc/systemd/system/${app}.service`,
      'sudo systemctl daemon-reload',
      `sudo systemctl enable --now ${app}`,
    ];
  },

  /** Commands that PROVE the service is installed and will survive a reboot. */
  verificationCommands(app) {
    return {
      SERVICE_RUNNING: `systemctl is-active ${app}`,
      SERVICE_ENABLED_AT_BOOT: `systemctl is-enabled ${app}`,
      REBOOT_RECOVERY_SUCCEEDED: `sudo reboot   # then: systemctl is-active ${app}`,
      logs: `journalctl -u ${app} -n 50`,
    };
  },
};
