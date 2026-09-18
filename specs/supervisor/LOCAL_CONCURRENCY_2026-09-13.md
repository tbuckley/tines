# Local runner concurrency policy and abuse review

The machine owner must opt in with `--allow-remote-concurrency`; `--max-concurrent` then becomes
an immutable local ceiling. Signed-in owners and ordinary owner API keys may request a revisioned
cap inside that ceiling. Ephemeral run keys retain read-only fleet access, runner tokens report
and acknowledge policy only for their own runner, and the browser cannot enable consent or raise
the ceiling.

The daemon's check immediately before process admission is the final resource boundary. Server
state is consent reporting, not machine attestation: an owner key can already rotate runner
credentials and disrupt routing, while a stolen runner token can lie about its own policy. Neither
can force a supported daemon to exceed its local ceiling. The ceiling bounds process count, not
CPU, memory, disk, network, or provider spend per process.

Requests and acknowledgements carry monotonic revisions. Stale saves fail, stale acknowledgements
are ignored, restart and re-registration invalidate acknowledgement until the new instance polls,
and malformed or unknown capability reports fail closed. Lowering a requested cap preserves
existing runs but blocks new claims. A local lower also prevents excess launch delivery; refused
launches are released atomically with their run keys revoked. Opt-out restores the local flag as
the effective cap, and later opt-in does not resurrect an older high request.

Machine owners reverse the feature by pausing, waiting for active work to finish, and reinstalling
or relaunching without the opt-in flag at the desired local cap. Service restart alone preserves
arguments. Older daemons remain usable but expose no durable web control.
