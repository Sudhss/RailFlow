"""
RailFlow Resume Metrics Benchmark
==================================
Runs the simulation under controlled stress-test conditions and computes:

  1. Route-Decision Latency  -- Dijkstra vs Bellman-Ford (weighted baseline)
  2. On-Time Performance     -- Agent-assisted vs No-agent baseline
  3. Manual Intervention     -- Automated agent actions vs manual-only baseline

Usage:
    cd <project-root>
    python -m backend.benchmark
"""

from __future__ import annotations

import copy
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .graph import RailwayGraph
from .simulation import RailFlowSimulation, SIM_TICK_MINUTES

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
GRAPH_PATH = DATA_DIR / "railway_graph.json"
MODEL_PATH = BASE_DIR / "models" / "railflow_ppo.zip"

# ---------------------------------------------------------------------------
# Benchmark configuration
# ---------------------------------------------------------------------------
TOTAL_SIM_TICKS = 600          # run each scenario for this many ticks
LATENCY_ITERATIONS = 1000      # repeat routing calls for stable timing
ON_TIME_THRESHOLD = 20         # a train with <= 20 ticks delay is "on-time"


# ═══════════════════════════════════════════════════════════════════════════
# Custom high-density stress-test scenarios
# ═══════════════════════════════════════════════════════════════════════════

STRESS_SCENARIOS: dict[str, dict[str, Any]] = {
    "corridor_overload": {
        "description": "8 trains competing on the NDLS-LKO corridor with staggered departures",
        "trains": [
            {"id": "ST-001", "name": "Rajdhani Express", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 0},
            {"id": "ST-002", "name": "Shatabdi Express", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 2},
            {"id": "ST-003", "name": "Gomti Express", "type": "express", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 5},
            {"id": "ST-004", "name": "Lucknow Mail", "type": "express", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 8},
            {"id": "ST-005", "name": "Kanpur Passenger", "type": "passenger", "source": "NDLS", "destination": "CNB", "scheduled_departure_tick": 3},
            {"id": "ST-006", "name": "Bareilly Passenger", "type": "passenger", "source": "NDLS", "destination": "BE", "scheduled_departure_tick": 6},
            {"id": "ST-007", "name": "Heavy Freight A", "type": "freight", "source": "CNB", "destination": "NDLS", "scheduled_departure_tick": 1},
            {"id": "ST-008", "name": "Heavy Freight B", "type": "freight", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 4},
        ],
        "incidents": [
            {"type": "speed_restriction", "edge_id": "BE-PMR", "severity": "warning", "speed_limit": 30, "note": "Fog near Bareilly"},
            {"type": "speed_restriction", "edge_id": "HRI-SAN", "severity": "warning", "speed_limit": 25, "note": "Waterlogging"},
        ],
    },
    "multi_closure_chaos": {
        "description": "6 trains with 3 track closures forcing major reroutes",
        "trains": [
            {"id": "MC-001", "name": "Priority Superfast", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 0},
            {"id": "MC-002", "name": "Delhi Express", "type": "express", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 3},
            {"id": "MC-003", "name": "Kanpur Shatabdi", "type": "superfast", "source": "NDLS", "destination": "CNB", "scheduled_departure_tick": 2},
            {"id": "MC-004", "name": "Reverse Freight", "type": "freight", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 0},
            {"id": "MC-005", "name": "Moradabad Local", "type": "passenger", "source": "NDLS", "destination": "MB", "scheduled_departure_tick": 5},
            {"id": "MC-006", "name": "Bareilly Passenger", "type": "passenger", "source": "GZB", "destination": "BE", "scheduled_departure_tick": 1},
        ],
        "incidents": [
            {"type": "track_closure", "edge_id": "BE-PMR", "severity": "critical", "note": "Signal failure"},
            {"type": "track_closure", "edge_id": "GMS-GJL", "severity": "critical", "note": "Derailment"},
            {"type": "speed_restriction", "edge_id": "NDLS-DSA", "severity": "warning", "speed_limit": 20, "note": "Heavy fog"},
        ],
    },
    "peak_hour_bidirectional": {
        "description": "10 trains in both directions causing head-on capacity conflicts",
        "trains": [
            # Eastbound
            {"id": "PH-E01", "name": "Morning Rajdhani", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 0},
            {"id": "PH-E02", "name": "Morning Express", "type": "express", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 2},
            {"id": "PH-E03", "name": "Kanpur Fast", "type": "express", "source": "NDLS", "destination": "CNB", "scheduled_departure_tick": 4},
            {"id": "PH-E04", "name": "Passenger Local A", "type": "passenger", "source": "NDLS", "destination": "MB", "scheduled_departure_tick": 1},
            {"id": "PH-E05", "name": "Freight East", "type": "freight", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 6},
            # Westbound
            {"id": "PH-W01", "name": "Lucknow Rajdhani", "type": "superfast", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 0},
            {"id": "PH-W02", "name": "Kanpur Express", "type": "express", "source": "CNB", "destination": "NDLS", "scheduled_departure_tick": 1},
            {"id": "PH-W03", "name": "Bareilly Return", "type": "passenger", "source": "BE", "destination": "NDLS", "scheduled_departure_tick": 3},
            {"id": "PH-W04", "name": "Freight West", "type": "freight", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 2},
            {"id": "PH-W05", "name": "Moradabad Exp", "type": "express", "source": "MB", "destination": "NDLS", "scheduled_departure_tick": 5},
        ],
        "incidents": [
            {"type": "speed_restriction", "edge_id": "SAN-AMG", "severity": "warning", "speed_limit": 30, "note": "Track maintenance"},
            {"type": "speed_restriction", "edge_id": "PKW-HPU", "severity": "warning", "speed_limit": 35, "note": "Signal upgrade"},
            {"type": "speed_restriction", "edge_id": "TDL-FZD", "severity": "warning", "speed_limit": 30, "note": "Monsoon damage"},
        ],
    },
    "cascade_failure": {
        "description": "Mid-simulation closures trigger cascading delays on 7 trains",
        "trains": [
            {"id": "CF-001", "name": "Express Alpha", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 0},
            {"id": "CF-002", "name": "Express Beta", "type": "express", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 3},
            {"id": "CF-003", "name": "Local Gamma", "type": "passenger", "source": "NDLS", "destination": "CNB", "scheduled_departure_tick": 1},
            {"id": "CF-004", "name": "Freight Delta", "type": "freight", "source": "CNB", "destination": "NDLS", "scheduled_departure_tick": 0},
            {"id": "CF-005", "name": "Return Express", "type": "express", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 2},
            {"id": "CF-006", "name": "Bareilly Shuttle", "type": "passenger", "source": "NDLS", "destination": "BE", "scheduled_departure_tick": 5},
            {"id": "CF-007", "name": "Night Freight", "type": "freight", "source": "LKO", "destination": "GZB", "scheduled_departure_tick": 8},
        ],
        "incidents": [
            {"type": "track_closure", "edge_id": "PMR-TLH", "severity": "critical", "note": "Bridge inspection"},
            {"type": "track_closure", "edge_id": "ETW-PHD", "severity": "critical", "note": "Landslide"},
            {"type": "speed_restriction", "edge_id": "AMG-LKO", "severity": "warning", "speed_limit": 20, "note": "Platform congestion"},
            {"type": "speed_restriction", "edge_id": "DSA-GZB", "severity": "warning", "speed_limit": 25, "note": "Fog"},
        ],
    },
    "saturated_network": {
        "description": "12 trains saturating all major corridors simultaneously",
        "trains": [
            {"id": "SN-001", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 0, "name": "Shatabdi 1"},
            {"id": "SN-002", "type": "superfast", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 0, "name": "Shatabdi 2"},
            {"id": "SN-003", "type": "express", "source": "NDLS", "destination": "CNB", "scheduled_departure_tick": 1, "name": "Prayagraj Exp"},
            {"id": "SN-004", "type": "express", "source": "CNB", "destination": "NDLS", "scheduled_departure_tick": 1, "name": "Shramshakti Exp"},
            {"id": "SN-005", "type": "passenger", "source": "NDLS", "destination": "MB", "scheduled_departure_tick": 2, "name": "MB Passenger"},
            {"id": "SN-006", "type": "passenger", "source": "MB", "destination": "LKO", "scheduled_departure_tick": 2, "name": "MB-LKO Local"},
            {"id": "SN-007", "type": "freight", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 3, "name": "Goods A"},
            {"id": "SN-008", "type": "freight", "source": "LKO", "destination": "NDLS", "scheduled_departure_tick": 3, "name": "Goods B"},
            {"id": "SN-009", "type": "express", "source": "GZB", "destination": "LKO", "scheduled_departure_tick": 4, "name": "GZB Express"},
            {"id": "SN-010", "type": "passenger", "source": "NDLS", "destination": "BE", "scheduled_departure_tick": 5, "name": "BE Passenger"},
            {"id": "SN-011", "type": "freight", "source": "CNB", "destination": "GZB", "scheduled_departure_tick": 6, "name": "Goods C"},
            {"id": "SN-012", "type": "superfast", "source": "NDLS", "destination": "LKO", "scheduled_departure_tick": 7, "name": "Late Rajdhani"},
        ],
        "incidents": [
            {"type": "speed_restriction", "edge_id": "BE-PMR", "severity": "warning", "speed_limit": 30, "note": "Track work"},
            {"type": "speed_restriction", "edge_id": "HRI-SAN", "severity": "warning", "speed_limit": 25, "note": "Waterlogging"},
            {"type": "speed_restriction", "edge_id": "NDLS-DSA", "severity": "warning", "speed_limit": 25, "note": "Platform congestion"},
            {"type": "track_closure", "edge_id": "GMS-GJL", "severity": "critical", "note": "Signal failure"},
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# METRIC 1 — Route-Decision Latency: Dijkstra vs Bellman-Ford
# ═══════════════════════════════════════════════════════════════════════════

def _bellman_ford(
    graph: RailwayGraph,
    start: str,
    destination: str,
    occupancy: dict[str, int],
) -> list[str] | None:
    """Bellman-Ford style relaxation -- correct weights but O(V*E) instead
    of O((V+E) log V).  This is the 'before Dijkstra' weighted baseline."""
    if start not in graph.stations or destination not in graph.stations:
        return None
    occupancy = occupancy or {}
    distances: dict[str, float] = {sid: math.inf for sid in graph.stations}
    previous: dict[str, str | None] = {sid: None for sid in graph.stations}
    distances[start] = 0.0

    num_nodes = len(graph.stations)
    for _ in range(num_nodes - 1):
        updated = False
        for edge in graph.edges.values():
            weight = graph.dynamic_weight(edge, occupancy.get(edge.id, 0))
            if math.isinf(weight):
                continue
            if distances[edge.from_node] + weight < distances[edge.to_node]:
                distances[edge.to_node] = distances[edge.from_node] + weight
                previous[edge.to_node] = edge.from_node
                updated = True
            if edge.bidirectional:
                if distances[edge.to_node] + weight < distances[edge.from_node]:
                    distances[edge.from_node] = distances[edge.to_node] + weight
                    previous[edge.from_node] = edge.to_node
                    updated = True
        if not updated:
            break

    if math.isinf(distances[destination]):
        return None
    path: list[str] = []
    cursor: str | None = destination
    while cursor is not None:
        path.append(cursor)
        cursor = previous[cursor]
    path.reverse()
    return path


@dataclass
class LatencyResult:
    pair: tuple[str, str]
    bellman_ford_ms: float
    dijkstra_ms: float
    bf_route_minutes: float | None
    dij_route_minutes: float | None


def benchmark_latency(graph: RailwayGraph, iterations: int = LATENCY_ITERATIONS) -> list[LatencyResult]:
    """Time Bellman-Ford and Dijkstra across representative OD pairs under
    varying congestion levels."""
    od_pairs = [
        ("NDLS", "LKO"),
        ("NDLS", "CNB"),
        ("CNB", "NDLS"),
        ("NDLS", "MB"),
        ("MB", "LKO"),
        ("GZB", "SPN"),
        ("LKO", "NDLS"),
        ("BE", "CNB"),
    ]
    # simulate moderate-to-heavy occupancy
    occupancy: dict[str, int] = {}
    for edge in graph.edges.values():
        occupancy[edge.id] = max(1, edge.capacity - 1)

    results: list[LatencyResult] = []
    for src, dst in od_pairs:
        # --- Bellman-Ford ---
        t0 = time.perf_counter()
        for _ in range(iterations):
            bf_path = _bellman_ford(graph, src, dst, occupancy)
        bf_ms = (time.perf_counter() - t0) / iterations * 1000

        # --- Dijkstra ---
        t0 = time.perf_counter()
        for _ in range(iterations):
            dij_path = graph.dijkstra(src, dst, occupancy)
        dij_ms = (time.perf_counter() - t0) / iterations * 1000

        bf_min = graph.total_route_minutes(bf_path, occupancy) if bf_path else None
        dij_min = graph.total_route_minutes(dij_path, occupancy) if dij_path else None

        results.append(LatencyResult(
            pair=(src, dst),
            bellman_ford_ms=bf_ms,
            dijkstra_ms=dij_ms,
            bf_route_minutes=bf_min,
            dij_route_minutes=dij_min,
        ))
    return results


# ═══════════════════════════════════════════════════════════════════════════
# METRIC 2 & 3 — On-Time Performance & Manual Intervention
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class ScenarioResult:
    scenario: str
    description: str
    num_trains: int
    ticks: int

    # with-agent run
    agent_total_delay: int
    agent_arrived: int
    agent_on_time: int
    agent_reroutes: int
    agent_holds: int
    agent_stops: int
    agent_total_actions: int
    agent_congestion_ticks: int

    # no-agent run
    noagent_total_delay: int
    noagent_arrived: int
    noagent_on_time: int
    noagent_congestion_ticks: int
    noagent_trains_stuck: int


def _setup_stress_scenario(sim: RailFlowSimulation, scenario_key: str) -> int:
    """Reset sim, add trains and incidents from a stress scenario. Returns
    train count."""
    sim.reset()
    sim.set_paused(False)
    scenario = STRESS_SCENARIOS[scenario_key]
    count = 0
    for t in scenario["trains"]:
        try:
            sim.add_train(t)
            count += 1
        except Exception:
            pass
    for inc in scenario.get("incidents", []):
        try:
            sim.add_incident(inc)
        except Exception:
            pass
    return count


def _run_stress(scenario_key: str, ticks: int, use_agent: bool) -> dict[str, Any]:
    """Run a headless simulation and collect detailed metrics."""
    sim = RailFlowSimulation(GRAPH_PATH, MODEL_PATH)
    num_trains = _setup_stress_scenario(sim, scenario_key)

    reroute_count = 0
    hold_count = 0
    stop_count = 0
    congestion_ticks = 0
    prev_decision_id = None

    for tick_i in range(ticks):
        if use_agent:
            sim.advance_tick()
        else:
            # advance without agent
            if sim.paused:
                continue
            sim.tick += SIM_TICK_MINUTES
            if sim.emergency_halt_active:
                for train in sim.trains.values():
                    if train.status != "arrived":
                        train.stop()
                        train.delay += 1
                continue
            for train in list(sim.trains.values()):
                sim._advance_train(train)

        # count congestion ticks (any edge over capacity)
        occ = sim.occupancy()
        for edge_id, count in occ.items():
            edge = sim.graph.edges.get(edge_id)
            if edge and count > edge.capacity:
                congestion_ticks += 1

        # count unique agent decisions
        if use_agent and sim.last_agent_decision:
            dec = sim.last_agent_decision
            dec_sig = (dec.get("train_id"), dec.get("decision"), str(dec.get("new_route")))
            if dec_sig != prev_decision_id:
                prev_decision_id = dec_sig
                d = dec.get("decision", "")
                if d == "reroute":
                    reroute_count += 1
                elif d == "hold":
                    hold_count += 1
                elif d == "stop":
                    stop_count += 1

    # final stats
    total_delay = 0
    arrived = 0
    on_time = 0
    stuck = 0
    for train in sim.trains.values():
        total_delay += train.delay
        if train.status == "arrived":
            arrived += 1
            if train.delay <= ON_TIME_THRESHOLD:
                on_time += 1
        elif train.status == "stopped":
            stuck += 1

    return {
        "num_trains": num_trains,
        "total_delay": total_delay,
        "arrived": arrived,
        "on_time": on_time,
        "reroutes": reroute_count,
        "holds": hold_count,
        "stops": stop_count,
        "total_actions": reroute_count + hold_count + stop_count,
        "congestion_ticks": congestion_ticks,
        "stuck": stuck,
    }


def benchmark_scenarios(ticks: int = TOTAL_SIM_TICKS) -> list[ScenarioResult]:
    results: list[ScenarioResult] = []
    for key, cfg in STRESS_SCENARIOS.items():
        with_agent = _run_stress(key, ticks, use_agent=True)
        no_agent = _run_stress(key, ticks, use_agent=False)

        results.append(ScenarioResult(
            scenario=key,
            description=cfg["description"],
            num_trains=with_agent["num_trains"],
            ticks=ticks,
            agent_total_delay=with_agent["total_delay"],
            agent_arrived=with_agent["arrived"],
            agent_on_time=with_agent["on_time"],
            agent_reroutes=with_agent["reroutes"],
            agent_holds=with_agent["holds"],
            agent_stops=with_agent["stops"],
            agent_total_actions=with_agent["total_actions"],
            agent_congestion_ticks=with_agent["congestion_ticks"],
            noagent_total_delay=no_agent["total_delay"],
            noagent_arrived=no_agent["arrived"],
            noagent_on_time=no_agent["on_time"],
            noagent_congestion_ticks=no_agent["congestion_ticks"],
            noagent_trains_stuck=no_agent["stuck"],
        ))
    return results


# ═══════════════════════════════════════════════════════════════════════════
# Report Generator
# ═══════════════════════════════════════════════════════════════════════════

def _pct(a: float, b: float) -> str:
    if b == 0:
        return "N/A"
    return f"{(b - a) / b * 100:+.1f}%"

def _pct_val(a: float, b: float) -> float:
    if b == 0:
        return 0.0
    return (b - a) / b * 100


def generate_report(
    latency_results: list[LatencyResult],
    scenario_results: list[ScenarioResult],
) -> str:
    L: list[str] = []
    w = L.append

    w("")
    w("=" * 100)
    w("                     RAILFLOW -- RESUME METRICS BENCHMARK REPORT")
    w("=" * 100)
    w("")

    # ------------------------------------------------------------------
    # METRIC 1
    # ------------------------------------------------------------------
    w("-" * 100)
    w("  METRIC 1: Route-Decision Latency -- Dijkstra vs Bellman-Ford (weighted baseline)")
    w("-" * 100)
    w("")
    w(f"  Each routing call averaged over {LATENCY_ITERATIONS} iterations.")
    w(f"  Occupancy set to (capacity - 1) per edge to simulate near-capacity load.")
    w("")
    w(f"  {'O-D Pair':<18} {'Bellman-Ford':>14} {'Dijkstra':>14} {'Reduction':>12} {'Same Route?':>12}")
    w("  " + "-" * 74)

    total_bf = 0.0
    total_dij = 0.0
    for r in latency_results:
        pair = f"{r.pair[0]} -> {r.pair[1]}"
        reduction = _pct(r.dijkstra_ms, r.bellman_ford_ms)
        same = "Yes" if r.bf_route_minutes == r.dij_route_minutes else "No"
        w(f"  {pair:<18} {r.bellman_ford_ms:>12.4f}ms {r.dijkstra_ms:>12.4f}ms {reduction:>12} {same:>12}")
        total_bf += r.bellman_ford_ms
        total_dij += r.dijkstra_ms

    w("  " + "-" * 74)
    avg_bf = total_bf / len(latency_results)
    avg_dij = total_dij / len(latency_results)
    lat_reduction = _pct_val(avg_dij, avg_bf)
    w(f"  {'AVERAGE':<18} {avg_bf:>12.4f}ms {avg_dij:>12.4f}ms {_pct(avg_dij, avg_bf):>12}")
    w("")
    w(f"  >>> Dijkstra reduces route-decision latency by {lat_reduction:.1f}% vs weighted baseline")
    w("")

    # ------------------------------------------------------------------
    # METRIC 2
    # ------------------------------------------------------------------
    w("-" * 100)
    w("  METRIC 2: On-Time Performance -- Agent vs No-Agent")
    w("-" * 100)
    w("")
    w(f"  Sim ticks: {TOTAL_SIM_TICKS}  |  On-time = delay <= {ON_TIME_THRESHOLD} ticks")
    w("")
    w(f"  {'Scenario':<26} {'Trains':>6} {'Agt Delay':>10} {'NoAgt Delay':>12} {'Delay Red.':>11} {'Agt OT%':>8} {'NoAgt OT%':>10} {'OT Diff':>8}")
    w("  " + "-" * 96)

    agg_a_ot = 0
    agg_a_total = 0
    agg_n_ot = 0
    agg_n_total = 0
    agg_a_delay = 0
    agg_n_delay = 0

    for s in scenario_results:
        a_ot_pct = (s.agent_on_time / max(1, s.agent_arrived) * 100) if s.agent_arrived else 0
        n_ot_pct = (s.noagent_on_time / max(1, s.noagent_arrived) * 100) if s.noagent_arrived else 0
        delay_red = _pct(s.agent_total_delay, s.noagent_total_delay)
        ot_diff = f"{a_ot_pct - n_ot_pct:+.0f}pp"

        w(f"  {s.scenario:<26} {s.num_trains:>6} {s.agent_total_delay:>10} {s.noagent_total_delay:>12} {delay_red:>11} {a_ot_pct:>7.0f}% {n_ot_pct:>9.0f}% {ot_diff:>8}")

        agg_a_ot += s.agent_on_time
        agg_a_total += s.agent_arrived
        agg_n_ot += s.noagent_on_time
        agg_n_total += s.noagent_arrived
        agg_a_delay += s.agent_total_delay
        agg_n_delay += s.noagent_total_delay

    w("  " + "-" * 96)
    ov_a_ot = agg_a_ot / max(1, agg_a_total) * 100
    ov_n_ot = agg_n_ot / max(1, agg_n_total) * 100
    ov_delay_red = _pct_val(agg_a_delay, agg_n_delay)
    ov_ot_diff = ov_a_ot - ov_n_ot
    w(f"  {'AGGREGATE':<26} {'':>6} {agg_a_delay:>10} {agg_n_delay:>12} {_pct(agg_a_delay, agg_n_delay):>11} {ov_a_ot:>7.0f}% {ov_n_ot:>9.0f}% {ov_ot_diff:+.0f}pp")
    w("")
    w(f"  >>> Agent reduces total delay by {ov_delay_red:.1f}%")
    w(f"  >>> On-time performance: {ov_a_ot:.0f}% (agent) vs {ov_n_ot:.0f}% (no-agent) = {ov_ot_diff:+.0f}pp improvement")
    w("")

    # ------------------------------------------------------------------
    # METRIC 3
    # ------------------------------------------------------------------
    w("-" * 100)
    w("  METRIC 3: Manual Intervention Reduction -- Automated Agent vs Manual-Only")
    w("-" * 100)
    w("")
    w("  Without agent: every congestion tick + stuck train = event requiring manual dispatcher action.")
    w("  With agent:    the automated agent handles reroutes, holds, and stops autonomously.")
    w("")
    w(f"  {'Scenario':<26} {'Agt Actions':>12} {'NoAgt Cong':>11} {'NoAgt Stuck':>12} {'Manual Evts':>12} {'Cong Reduct':>12}")
    w("  " + "-" * 89)

    agg_a_actions = 0
    agg_manual_events = 0
    agg_a_cong = 0
    agg_n_cong = 0

    for s in scenario_results:
        manual_events = s.noagent_congestion_ticks + s.noagent_trains_stuck
        cong_red = _pct(s.agent_congestion_ticks, s.noagent_congestion_ticks) if s.noagent_congestion_ticks else "N/A"

        w(f"  {s.scenario:<26} {s.agent_total_actions:>12} {s.noagent_congestion_ticks:>11} {s.noagent_trains_stuck:>12} {manual_events:>12} {cong_red:>12}")

        agg_a_actions += s.agent_total_actions
        agg_manual_events += manual_events
        agg_a_cong += s.agent_congestion_ticks
        agg_n_cong += s.noagent_congestion_ticks

    w("  " + "-" * 89)
    interv_red = _pct_val(agg_a_actions, agg_manual_events) if agg_manual_events else 0
    cong_red_agg = _pct_val(agg_a_cong, agg_n_cong) if agg_n_cong else 0
    w(f"  {'AGGREGATE':<26} {agg_a_actions:>12} {agg_n_cong:>11} {'':>12} {agg_manual_events:>12} {_pct(agg_a_cong, agg_n_cong):>12}")
    w("")
    w(f"  >>> Agent automated {agg_a_actions} actions, eliminating {interv_red:.1f}% of {agg_manual_events} manual events")
    w(f"  >>> Congestion-ticks reduced by {cong_red_agg:.1f}% with agent active")
    w("")

    # ------------------------------------------------------------------
    # DETAIL: Per-scenario breakdown
    # ------------------------------------------------------------------
    w("-" * 100)
    w("  DETAIL: Agent Action Breakdown per Scenario")
    w("-" * 100)
    w("")
    w(f"  {'Scenario':<26} {'Reroutes':>10} {'Holds':>8} {'Stops':>8} {'Total':>8}")
    w("  " + "-" * 64)
    for s in scenario_results:
        w(f"  {s.scenario:<26} {s.agent_reroutes:>10} {s.agent_holds:>8} {s.agent_stops:>8} {s.agent_total_actions:>8}")
    w("")

    # ------------------------------------------------------------------
    # SUMMARY
    # ------------------------------------------------------------------
    w("=" * 100)
    w("                              RESUME METRICS SUMMARY")
    w("=" * 100)
    w("")
    w(f"  1. Route-Decision Latency Reduction (Dijkstra vs Bellman-Ford):  {lat_reduction:.1f}%")
    w(f"  2. On-Time Performance Improvement  (Agent vs no-agent):         {ov_ot_diff:+.0f}pp  ({ov_a_ot:.0f}% vs {ov_n_ot:.0f}%)")
    w(f"  3. Delay Reduction                  (Agent vs no-agent):         {ov_delay_red:.1f}%")
    w(f"  4. Manual Intervention Reduction     (Automated vs manual):      {interv_red:.1f}%")
    w(f"  5. Congestion-Ticks Reduction        (Agent vs no-agent):        {cong_red_agg:.1f}%")
    w("")
    w("  Methodology:")
    w(f"    - {len(STRESS_SCENARIOS)} stress-test scenarios with {sum(len(s['trains']) for s in STRESS_SCENARIOS.values())} total trains")
    w(f"    - {TOTAL_SIM_TICKS} simulation ticks per scenario")
    w(f"    - {LATENCY_ITERATIONS} iterations per routing call for latency measurement")
    w(f"    - On-time threshold: <= {ON_TIME_THRESHOLD} ticks delay")
    w("")
    w("=" * 100)
    w("")

    return "\n".join(L)


# ═══════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════

def main() -> None:
    import sys

    print("\n  RailFlow Resume Metrics Benchmark")
    print("  " + "=" * 40)
    print(f"  Scenarios: {len(STRESS_SCENARIOS)}")
    print(f"  Ticks per scenario: {TOTAL_SIM_TICKS}")
    print(f"  Latency iterations: {LATENCY_ITERATIONS}\n")

    print("  [1/3] Benchmarking route-decision latency...")
    graph = RailwayGraph(GRAPH_PATH)
    latency_results = benchmark_latency(graph)

    print("  [2/3] Running stress scenarios WITH agent...")
    print("  [3/3] Running stress scenarios WITHOUT agent...")
    scenario_results = benchmark_scenarios()

    report = generate_report(latency_results, scenario_results)

    # Save to file (UTF-8)
    output_path = BASE_DIR / "benchmark_report.txt"
    output_path.write_text(report, encoding="utf-8")

    # Print to console
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(report)
    print(f"  Report saved to: {output_path}\n")


if __name__ == "__main__":
    main()
