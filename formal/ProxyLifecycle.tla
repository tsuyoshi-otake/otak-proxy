---------------------------- MODULE ProxyLifecycle ----------------------------
EXTENDS Naturals, FiniteSets

(*
  Implementation-independent bounded model of a proxy detection/apply lifecycle.

  Environment assumptions made explicit by Spec:
  - Actors is non-empty and finite; a check consumes at most one bounded resource.
  - An enabled normal completion, late completion, or recovery is weakly fair.
  - Logical time is bounded by MaxTime.  It models timeout order, not wall-clock
    duration.
  - A stopped/cancelled check may complete late, but it has an older epoch and
    must not recreate an active effect.
*)

CONSTANTS Actors, MaxRetries, MaxTime, MaxResources, MaxEpoch

ASSUME /\ Actors # {}
       /\ MaxRetries \in Nat
       /\ MaxTime \in Nat
       /\ MaxResources \in Nat
       /\ MaxEpoch \in Nat

PHASES == {
    "Idle", "Running", "Checking", "Applied", "Failed", "Stopped", "Crashed", "Recovering"
}

VARIABLES phase, attempts, logicalTime, resourceUse, pending,
          effectEpoch, checkEpoch, completedEpoch, pulse

vars == <<phase, attempts, logicalTime, resourceUse, pending,
          effectEpoch, checkEpoch, completedEpoch, pulse>>

Init ==
    /\ phase = [a \in Actors |-> "Idle"]
    /\ attempts = [a \in Actors |-> 0]
    /\ logicalTime = 0
    /\ resourceUse = 0
    /\ pending = [a \in Actors |-> FALSE]
    /\ effectEpoch = [a \in Actors |-> 0]
    /\ checkEpoch = [a \in Actors |-> 0]
    /\ completedEpoch = [a \in Actors |-> 0]
    /\ pulse = 0

Start(a) ==
    /\ phase[a] \in {"Idle", "Stopped", "Applied"}
    /\ ~pending[a]
    /\ phase' = [phase EXCEPT ![a] = "Running"]
    /\ attempts' = [attempts EXCEPT ![a] = 0]
    /\ UNCHANGED <<logicalTime, resourceUse, pending, effectEpoch, checkEpoch, completedEpoch, pulse>>

BeginCheck(a) ==
    /\ phase[a] = "Running"
    /\ ~pending[a]
    /\ resourceUse < MaxResources
    /\ phase' = [phase EXCEPT ![a] = "Checking"]
    /\ resourceUse' = resourceUse + 1
    /\ pending' = [pending EXCEPT ![a] = TRUE]
    /\ checkEpoch' = [checkEpoch EXCEPT ![a] = effectEpoch[a]]
    /\ UNCHANGED <<attempts, logicalTime, effectEpoch, completedEpoch, pulse>>

Complete(a) ==
    /\ phase[a] = "Checking"
    /\ pending[a]
    /\ checkEpoch[a] = effectEpoch[a]
    /\ resourceUse > 0
    /\ phase' = [phase EXCEPT ![a] = "Applied"]
    /\ resourceUse' = resourceUse - 1
    /\ pending' = [pending EXCEPT ![a] = FALSE]
    /\ completedEpoch' = [completedEpoch EXCEPT ![a] = effectEpoch[a]]
    /\ UNCHANGED <<attempts, logicalTime, effectEpoch, checkEpoch, pulse>>

Stop(a) ==
    /\ phase[a] \in {"Running", "Checking", "Applied", "Failed"}
    /\ effectEpoch[a] < MaxEpoch
    /\ phase' = [phase EXCEPT ![a] = "Stopped"]
    /\ effectEpoch' = [effectEpoch EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<attempts, logicalTime, resourceUse, pending, checkEpoch, completedEpoch, pulse>>

Timeout(a) ==
    /\ phase[a] = "Checking"
    /\ pending[a]
    /\ logicalTime = MaxTime
    /\ effectEpoch[a] < MaxEpoch
    /\ phase' = [phase EXCEPT ![a] = "Failed"]
    /\ effectEpoch' = [effectEpoch EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<attempts, logicalTime, resourceUse, pending, checkEpoch, completedEpoch, pulse>>

Crash(a) ==
    /\ phase[a] \in {"Running", "Checking", "Applied", "Failed", "Stopped"}
    /\ effectEpoch[a] < MaxEpoch
    /\ phase' = [phase EXCEPT ![a] = "Crashed"]
    /\ effectEpoch' = [effectEpoch EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<attempts, logicalTime, resourceUse, pending, checkEpoch, completedEpoch, pulse>>

Restart(a) ==
    /\ phase[a] = "Crashed"
    /\ phase' = [phase EXCEPT ![a] = "Recovering"]
    /\ UNCHANGED <<attempts, logicalTime, resourceUse, pending, effectEpoch, checkEpoch, completedEpoch, pulse>>

Recover(a) ==
    /\ phase[a] = "Recovering"
    /\ (~pending[a] \/ resourceUse > 0)
    /\ phase' = [phase EXCEPT ![a] = "Running"]
    /\ resourceUse' = IF pending[a] THEN resourceUse - 1 ELSE resourceUse
    /\ pending' = [pending EXCEPT ![a] = FALSE]
    /\ UNCHANGED <<attempts, logicalTime, effectEpoch, checkEpoch, completedEpoch, pulse>>

LateComplete(a) ==
    /\ pending[a]
    /\ phase[a] \in {"Stopped", "Failed", "Crashed", "Recovering"}
    /\ checkEpoch[a] # effectEpoch[a]
    /\ resourceUse > 0
    /\ resourceUse' = resourceUse - 1
    /\ pending' = [pending EXCEPT ![a] = FALSE]
    /\ UNCHANGED <<phase, attempts, logicalTime, effectEpoch, checkEpoch, completedEpoch, pulse>>

Retry(a) ==
    /\ phase[a] = "Failed"
    /\ ~pending[a]
    /\ attempts[a] < MaxRetries
    /\ phase' = [phase EXCEPT ![a] = "Running"]
    /\ attempts' = [attempts EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<logicalTime, resourceUse, pending, effectEpoch, checkEpoch, completedEpoch, pulse>>

Tick ==
    /\ logicalTime < MaxTime
    /\ logicalTime' = logicalTime + 1
    /\ UNCHANGED <<phase, attempts, resourceUse, pending, effectEpoch, checkEpoch, completedEpoch, pulse>>

Pulse ==
    /\ pulse' = 1 - pulse
    /\ UNCHANGED <<phase, attempts, logicalTime, resourceUse, pending, effectEpoch, checkEpoch, completedEpoch>>

Next ==
    \/ (\E a \in Actors : Start(a))
    \/ (\E a \in Actors : BeginCheck(a))
    \/ (\E a \in Actors : Complete(a))
    \/ (\E a \in Actors : Stop(a))
    \/ (\E a \in Actors : Timeout(a))
    \/ (\E a \in Actors : Crash(a))
    \/ (\E a \in Actors : Restart(a))
    \/ (\E a \in Actors : Recover(a))
    \/ (\E a \in Actors : LateComplete(a))
    \/ (\E a \in Actors : Retry(a))
    \/ Tick
    \/ Pulse

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A a \in Actors : WF_vars(Complete(a))
    /\ \A a \in Actors : WF_vars(LateComplete(a))
    /\ \A a \in Actors : WF_vars(Recover(a))

TypeOK ==
    /\ phase \in [Actors -> PHASES]
    /\ attempts \in [Actors -> 0..MaxRetries]
    /\ logicalTime \in 0..MaxTime
    /\ resourceUse \in 0..MaxResources
    /\ pending \in [Actors -> BOOLEAN]
    /\ effectEpoch \in [Actors -> 0..MaxEpoch]
    /\ checkEpoch \in [Actors -> 0..MaxEpoch]
    /\ completedEpoch \in [Actors -> 0..MaxEpoch]
    /\ pulse \in {0, 1}

ResourceBound == resourceUse <= MaxResources

ResourceAccounting ==
    resourceUse = Cardinality({a \in Actors : pending[a]})

NoStoppedEffect ==
    \A a \in Actors : phase[a] = "Stopped" => completedEpoch[a] # effectEpoch[a]

RequiredApplied == \E a \in Actors : phase[a] = "Applied"

NeverApplied == \A a \in Actors : phase[a] # "Applied"

CheckTerminates ==
    \A a \in Actors : (phase[a] = "Checking") ~>
        (phase[a] \in {"Applied", "Stopped", "Failed", "Crashed"})

=============================================================================
