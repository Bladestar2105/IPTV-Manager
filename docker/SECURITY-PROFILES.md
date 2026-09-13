# AI container profiles

These profiles are required only for personal ChatGPT connections, enabled with
`docker compose -f docker-compose.yml -f docker-compose.chatgpt.yml up -d`.
The standard Compose stack uses Docker defaults and needs no profile files.
The seccomp path is read by Compose, not from inside the application image.
Portainer Web Editor/upload does not include adjacent repository files; use the
[installation and repair instructions](../README.md#using-docker-compose-or-portainer).

`ai-seccomp.json` and `ai-apparmor` are derived from the Apache-2.0
[Moby profiles](https://github.com/moby/profiles/tree/61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31)
revision `61eaf32614c7c71b60bd8927d3e6a4ffc8ff1f31`. The upstream license is
preserved in `LICENSE.moby`.

The seccomp profile retains the upstream default-deny allowlist. The three
`IPTV-Manager:` rules allow bubblewrap's nested user/mount/ipc/pid/uts/cgroup
namespace creation on amd64/arm64, its secondary user namespace, and filesystem
setup. They do not grant container capabilities or enable `clone3`.

Docker's protected `/proc` paths remain in place. The sandbox constructs a
read-only tmpfs at `/proc` with only a fixed `/proc/self/exe` symlink for runtime
startup; it never mounts procfs or shares the manager's process tree. This avoids
the kernel restriction on nested procfs mounts without removing system masks.

The named AppArmor profile retains Docker's sensitive-path and kernel-interface
denials. It permits synthetic tmpfs/devpts mounts, bind mounts, remounts,
private/slave propagation, and root pivots used by bubblewrap.
It does not replace the Docker daemon's default profile. The Docker host must
install and load it before an AppArmor-enabled container selects it:

```sh
sudo install -o root -g root -m 0644 docker/ai-apparmor /etc/apparmor.d/iptv-manager-ai
sudo apparmor_parser -r -W /etc/apparmor.d/iptv-manager-ai
```

Keep the host's AppArmor boot service enabled to reload this persistent profile
before Docker starts the container after a reboot.

Use `--security-opt seccomp=./docker/ai-seccomp.json`. On hosts where `docker info`
reports AppArmor, also use `--security-opt apparmor=iptv-manager-ai`; omit this
second option on hosts without AppArmor. Do not disable another host LSM.

Host policy must permit unprivileged user namespaces. Keep any host userns
restriction enabled and authorize the named profile rather than disabling it
globally. Run the application's AI runtime check under the actual service user
after installation; namespace availability alone does not verify filesystem
containment.
