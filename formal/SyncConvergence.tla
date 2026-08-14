---------------------------- MODULE SyncConvergence ---------------------------
EXTENDS Naturals, FiniteSets

(*
  Implementation-independent bounded model of logical-version replication.

  Environment assumptions made explicit by Spec:
  - Actors is finite and non-empty; a per-origin queue is bounded by MaxQueue.
  - Publish increments bounded logical time; no wall-clock ordering is assumed.
  - Delivery order is adversarial and duplicate messages are allowed.
  - Drop is bounded by MaxDrops.  Liveness configurations set MaxDrops = 0;
    loss configurations deliberately expose the consequence of relaxing that
    reliability assumption.
  - Each continuously queued origin is weakly fairly delivered.
*)

CONSTANTS Actors, MaxClock, MaxQueue, MaxDrops

ASSUME /\ Actors # {}
       /\ MaxClock \in Nat
       /\ MaxQueue \in Nat
       /\ MaxDrops \in Nat

VARIABLES logicalTime, version, replica, queued, dropsRemaining, pulse

vars == <<logicalTime, version, replica, queued, dropsRemaining, pulse>>

MaxValue(values) ==
    CHOOSE value \in values : \A other \in values : other <= value

GlobalMaximum(origin) ==
    MaxValue({replica[a] : a \in Actors} \cup {version[origin]})

Init ==
    /\ logicalTime = 0
    /\ version = [a \in Actors |-> 0]
    /\ replica = [a \in Actors |-> 0]
    /\ queued = [a \in Actors |-> 0]
    /\ dropsRemaining = MaxDrops
    /\ pulse = 0

Publish(a) ==
    /\ logicalTime < MaxClock
    /\ version[a] < MaxClock
    /\ queued[a] < MaxQueue
    /\ logicalTime' = logicalTime + 1
    /\ version' = [version EXCEPT ![a] = @ + 1]
    /\ replica' = [replica EXCEPT ![a] = version[a] + 1]
    /\ queued' = [queued EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<dropsRemaining, pulse>>

Duplicate(a) ==
    /\ queued[a] > 0
    /\ queued[a] < MaxQueue
    /\ queued' = [queued EXCEPT ![a] = @ + 1]
    /\ UNCHANGED <<logicalTime, version, replica, dropsRemaining, pulse>>

Deliver(a) ==
    LET adopted == GlobalMaximum(a) IN
    /\ queued[a] > 0
    /\ replica' = [b \in Actors |-> adopted]
    /\ queued' = [queued EXCEPT ![a] = @ - 1]
    /\ UNCHANGED <<logicalTime, version, dropsRemaining, pulse>>

Drop(a) ==
    /\ dropsRemaining > 0
    /\ queued[a] > 0
    /\ queued' = [queued EXCEPT ![a] = @ - 1]
    /\ dropsRemaining' = dropsRemaining - 1
    /\ UNCHANGED <<logicalTime, version, replica, pulse>>

Pulse ==
    /\ pulse' = 1 - pulse
    /\ UNCHANGED <<logicalTime, version, replica, queued, dropsRemaining>>

Next ==
    \/ (\E a \in Actors : Publish(a))
    \/ (\E a \in Actors : Duplicate(a))
    \/ (\E a \in Actors : Deliver(a))
    \/ (\E a \in Actors : Drop(a))
    \/ Pulse

Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ \A a \in Actors : WF_vars(Deliver(a))

TypeOK ==
    /\ logicalTime \in 0..MaxClock
    /\ version \in [Actors -> 0..MaxClock]
    /\ replica \in [Actors -> 0..MaxClock]
    /\ queued \in [Actors -> 0..MaxQueue]
    /\ dropsRemaining \in 0..MaxDrops
    /\ pulse \in {0, 1}

QueueBound == \A a \in Actors : queued[a] <= MaxQueue

Converged ==
    \A a \in Actors : \A b \in Actors : replica[a] = replica[b]

Quiescent == \A a \in Actors : queued[a] = 0

ConvergedWhenQuiescent == Quiescent => Converged

ActionDoesNotRegressReplica ==
    \A a \in Actors : replica'[a] >= replica[a]

NoStaleAdoption == [] [ActionDoesNotRegressReplica]_vars

Stable == logicalTime = MaxClock

ConvergesAfterStable == Stable ~> Converged

NeverPublishedDivergence == logicalTime = 0 \/ Converged

=============================================================================
