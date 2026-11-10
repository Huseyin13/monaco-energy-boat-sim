# Monaco Energy Boat Sim

Browser-based simulator for an Energy Class catamaran, built around the Monaco Energy Boat Challenge. It is used to test boat behaviour, compare power sources and look at energy use per run.

Built with Three.js, no build step.

## Features

- Force-based boat dynamics: propeller model (advance ratio, ventilation), hull and wave-making drag with hump/planing, added mass, rudder in the propeller slipstream, wind with gusts
- Motor/controller thermal model with derating
- Three power sources: battery (internal resistance), hydrogen fuel cell (slew-limited, with buffer), solar with MPPT and buffer battery
- Port Hercule layout with shoreline collision
- Courses: slalom, endurance lap, 250 m sprint, with buoy penalties and a ghost of the best run
- Telemetry at 4 Hz, run report with Wh/km, CSV export
- Optional Web Serial output in the same packet format as the RC boat firmware

## Running

ES modules and the import map need a local server:

```bash
cd monaco_sim
python3 -m http.server 8000
```

Then open http://localhost:8000. VS Code Live Server works as well.

## Controls

| Key | Action |
|---|---|
| W / S | throttle / reverse |
| A / D | rudder |
| 1 / 2 / 3 | battery / hydrogen / solar |
| R | refill energy |
| 4 / 5 / 6 | slalom / endurance / sprint |
| T | restart course |
| G | run report |
| E | export CSV |
| N | advance time of day |
| B | change wind |
| L | connect / disconnect serial link |

## Layout

```
index.html
js/
  main.js            scene, input, HUD, main loop
  physics.js         boat dynamics
  energy.js          power sources
  boat.js            model loading, heave/pitch/roll
  water.js           wave surface
  course.js          gates, timing, ghost
  environment.js     harbour geometry and colliders
  telemetry.js       logging and stats
  charts.js          canvas charts
  wake.js            foam particles
  dashboard_link.js  Web Serial output
assets/
  boat.glb           catamaran model
  boat.blend         Blender source
```
