"""RailFlow simulation self-test.

Asserts the invariants the operations console depends on. It drives the
simulation directly rather than over HTTP, so it needs nothing but the base
requirements.

    python -m backend.selftest

Each check states the behaviour it protects. Several of them exist because the
behaviour was once wrong: a halt used to cancel trains that had not departed, a
reopened section used to leave the trains it stranded stranded forever, and a
manual route that visited a station twice used to loop for ever.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .graph import RailwayGraph
from .simulation import RailFlowSimulation, SimulationError

BASE_DIR = Path(__file__).resolve().parent
GRAPH_PATH = BASE_DIR / "data" / "railway_graph.json"
MODEL_PATH = BASE_DIR / "models" / "railflow_ppo.zip"

_failures: list[str] = []
_checks = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global _checks
    _checks += 1
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}" + (f" -- {detail}" if detail else ""))
        _failures.append(name)


def sim() -> RailFlowSimulation:
    return RailFlowSimulation(GRAPH_PATH, MODEL_PATH)


def section(title: str) -> None:
    print(f"\n{title}")


# --------------------------------------------------------------------------- graph


def test_graph() -> None:
    section("Railway graph")
    graph = RailwayGraph(GRAPH_PATH)

    seen = {"NDLS"}
    queue = ["NDLS"]
    while queue:
        node = queue.pop()
        for neighbour in graph.adjacency.get(node, {}):
            if neighbour not in seen:
                seen.add(neighbour)
                queue.append(neighbour)
    check("every station is reachable", len(seen) == len(graph.stations),
          f"{len(seen)} of {len(graph.stations)}")

    check(
        "every section has valid endpoints",
        all(e.from_node in graph.stations and e.to_node in graph.stations for e in graph.edges.values()),
    )
    check(
        "every section has a positive length and speed",
        all(e.distance_km > 0 and e.avg_speed > 0 and e.capacity >= 1 for e in graph.edges.values()),
    )

    route = graph.dijkstra("NDLS", "LKO")
    check("a route exists from NDLS to LKO", bool(route) and route[0] == "NDLS" and route[-1] == "LKO")

    valid, _ = graph.validate_route(["NDLS", "DSA", "NDLS", "DSA", "GZB"], {"NDLS"}, "GZB")
    check("a route that revisits a station is rejected", not valid)


# ---------------------------------------------------------------------- movement


def test_movement() -> None:
    section("Train movement")
    s = sim()
    s.seed_scenario("mixed_peak")
    s.set_paused(False)
    for _ in range(600):
        s.advance_tick()
    arrived = [t for t in s.trains.values() if t.status == "arrived"]
    check("every seeded train completes its journey in 600 ticks",
          len(arrived) == len(s.trains), f"{len(arrived)} of {len(s.trains)}")

    # Distance must carry across a node instead of being discarded, or a fast
    # train silently loses travel at every station it passes.
    s = sim()
    s.add_train({"id": "FAST", "type": "superfast", "source": "NDLS", "destination": "LKO"})
    s.set_paused(False)
    train = s.trains["FAST"]
    carried = False
    for _ in range(60):
        before = train.edge_id
        s.advance_tick()
        if before and train.edge_id != before and train.status == "moving" and train.edge_progress > 0:
            carried = True
            break
    check("travel carries over a node boundary", carried)

    s = sim()
    s.add_train({"id": "SAME", "type": "express", "source": "NDLS", "destination": "NDLS"})
    s.set_paused(False)
    for _ in range(5):
        s.advance_tick()
    check("a train booked to its own origin arrives", s.trains["SAME"].status == "arrived")


# ------------------------------------------------------------------------- holds


def test_holds() -> None:
    section("Holds and releases")

    s = sim()
    s.add_train({"id": "LATE", "type": "express", "source": "NDLS", "destination": "LKO",
                 "scheduled_departure_tick": 30})
    s.set_paused(False)
    s.advance_tick()
    s.emergency_halt(True)
    held_state = s.trains["LATE"].status
    s.emergency_halt(False)
    for _ in range(60):
        s.advance_tick()
    train = s.trains["LATE"]
    check("a halt does not cancel a train that has not departed", held_state == "scheduled")
    check("and it still departs on time afterwards",
          train.status != "scheduled" and train.delay == 0, f"status={train.status} delay={train.delay}")

    s = sim()
    s.add_train({"id": "B1", "type": "express", "source": "NDLS", "destination": "LKO"})
    s.set_paused(False)
    for _ in range(4):
        s.advance_tick()
    edge_id = s.trains["B1"].edge_id
    s.close_track(edge_id)
    s.advance_tick()
    stopped = s.trains["B1"].status == "stopped"
    s.reopen_track(edge_id)
    for _ in range(10):
        s.advance_tick()
    check("closing an occupied section holds the train on it", stopped)
    check("reopening it releases the train", s.trains["B1"].status in {"moving", "dwelling"},
          f"status={s.trains['B1'].status}")

    # A dispatcher's stop is a decision; nothing automatic may undo it.
    s = sim()
    s.add_train({"id": "D1", "type": "express", "source": "NDLS", "destination": "LKO"})
    s.set_paused(False)
    for _ in range(3):
        s.advance_tick()
    s.stop_train("D1")
    s.optimize_active_routes(reason="selftest")
    for _ in range(20):
        s.advance_tick()
    check("a dispatcher stop is never released by the system", s.trains["D1"].status == "stopped",
          f"status={s.trains['D1'].status}")

    s = sim()
    s.add_train({"id": "E1", "type": "express", "source": "NDLS", "destination": "LKO"})
    s.set_paused(False)
    for _ in range(3):
        s.advance_tick()
    s.emergency_halt(True)
    s.advance_tick()
    s.emergency_halt(False)
    for _ in range(5):
        s.advance_tick()
    check("a halted train resumes when the halt is released",
          s.trains["E1"].status in {"moving", "dwelling"}, f"status={s.trains['E1'].status}")


# -------------------------------------------------------------------- validation


def test_validation() -> None:
    section("Input validation")

    cases = [
        ("unknown train type", {"id": "A", "type": "bullet", "source": "NDLS", "destination": "LKO"}),
        ("zero max speed", {"id": "B", "type": "express", "source": "NDLS", "destination": "LKO", "max_speed": 0}),
        ("negative max speed", {"id": "C", "type": "express", "source": "NDLS", "destination": "LKO", "max_speed": -40}),
        ("unknown station", {"id": "D", "type": "express", "source": "ZZZ", "destination": "LKO"}),
        ("blank id", {"id": "  ", "type": "express", "source": "NDLS", "destination": "LKO"}),
        ("priority out of range", {"id": "E", "type": "express", "source": "NDLS", "destination": "LKO", "priority": 9}),
    ]
    for name, payload in cases:
        s = sim()
        try:
            s.add_train(payload)
            check(f"{name} is rejected", False, "it was accepted")
        except SimulationError:
            check(f"{name} is rejected", True)
        except Exception as exc:  # noqa: BLE001
            check(f"{name} is rejected as a client error", False, f"raised {type(exc).__name__}")

    s = sim()
    try:
        s.seed_scenario("does_not_exist")
        check("an unknown scenario is rejected", False)
    except SimulationError:
        check("an unknown scenario is rejected", True)

    s = sim()
    try:
        s.add_incident({"type": "alien_attack", "edge_id": "BE-PMR"})
        check("an unknown incident type is rejected", False)
    except SimulationError:
        check("an unknown incident type is rejected", True)

    s = sim()
    try:
        s.add_incident({"type": "speed_restriction", "edge_id": "BE-PMR"})
        check("a speed restriction without a limit is rejected", False)
    except SimulationError:
        check("a speed restriction without a limit is rejected", True)

    s = sim()
    s.add_train({"id": "L", "type": "express", "source": "NDLS", "destination": "GZB"})
    try:
        s.set_manual_route("L", ["NDLS", "DSA", "NDLS", "DSA", "GZB"])
        check("a looping manual route is rejected", False)
    except SimulationError:
        check("a looping manual route is rejected", True)


# ------------------------------------------------------------------- API surface


def test_snapshot() -> None:
    section("Snapshot contract")
    s = sim()
    s.seed_scenario("mixed_peak")
    s.set_paused(False)
    for _ in range(12):
        s.advance_tick()
    snap = s.snapshot()

    for key in ("simulation", "graph", "trains", "incidents", "logs_latest", "last_agent_decision"):
        check(f"snapshot has {key}", key in snap)

    train = snap["trains"][0]
    for key in ("id", "status", "current_node", "edge_progress", "current_speed", "delay",
                "route", "display_route", "on_edge", "system_held", "history"):
        check(f"train has {key}", key in train)

    check("display_route starts at the origin", train["display_route"][0] == train["source"])
    check("display_route ends at the destination", train["display_route"][-1] == train["destination"])

    edge = snap["graph"]["edges"][0]
    for key in ("id", "from", "to", "distance_km", "capacity", "load_ratio", "congestion", "blocked"):
        check(f"section has {key}", key in edge)

    for key in ("train_types", "scenarios", "incident_types", "tick_interval_seconds", "sim_time"):
        check(f"simulation metadata has {key}", key in snap["simulation"])


def test_agent_toggle() -> None:
    section("Benchmark support")
    s = sim()
    s.agent_enabled = False
    s.seed_scenario("mixed_peak")
    s.set_paused(False)
    for _ in range(80):
        s.advance_tick()
    check("the agent can be switched off for a baseline run", s.last_agent_decision is None)


def main() -> int:
    print("RailFlow simulation self-test")
    test_graph()
    test_movement()
    test_holds()
    test_validation()
    test_snapshot()
    test_agent_toggle()
    print(f"\n{_checks - len(_failures)} of {_checks} checks passed")
    if _failures:
        print("Failed: " + ", ".join(_failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
