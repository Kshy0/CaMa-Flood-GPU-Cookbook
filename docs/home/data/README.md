# Data of the home page

`docs/index.html` reads two generated scripts from this folder, written by
`tools/home_data.py` from a CaMa-Flood-GPU run; do not edit them by hand.

| file | used by | contents |
|---|---|---|
| `rivers.js` | hero map, runoff grid, river network, whole basins per GPU | river reaches as packed polylines with their upstream-area class and GPU, daily mean discharge at each reach end (log scale, 4 bits, packed as runs) and, for the larger rivers, in 32 steps between their own low and high for the hover readout, daily discharge at all river mouths, the main stems of 18 well-known rivers, the annual mean runoff of the forcing in 2° cells, a caption describing the run |
| `hydrograph.js` | storage and flow, CFL condition, statistics figures | daily mean outflow and river depth, monthly maximum outflow, bank height, channel width, distance to the next outlet and flood table at the Mekong at Mukdahan and the Amazon at Manacapuru; the unit catchments and rivers around Manacapuru on the 1-arcmin map with the daily discharge of each of those catchments, scaled between its own low and high water of the year |

The committed files come from `glb_15min`, year 2000 of `scripts/run_netcdf.py` with
one spin-up year, driven by the daily 0.25° eartH2Observe WRR2 runoff of ECMWF's
HTESSEL. That run saves daily `mean` `total_outflow` and `river_depth` and the
monthly `max_mean` `total_outflow` for all catchments, with
`StatisticsPlan(inner=CalendarWindow(period="day"), outer=CalendarWindow(period="month"))`.
Export another run of that kind:

```bash
python tools/home_data.py --params .../inp/glb_15min/parameters.nc --run .../out/glb_15min_e2o \
    --runoff .../E2O_ecmwf/e2o_ecmwf_wrr2_glob15_day_Runoff_2000.nc \
    --hires .../map/glb_15min/1min \
    --forcing "daily eartH2Observe WRR2 runoff (ECMWF HTESSEL, 0.25°)" --spin-up-years 1
```

The caption takes the map from the parameter path, the year from the output, and the
forcing and spin-up from the arguments. `--min-upstream-km2` (default 20000) sets which
catchments the maps draw; raise it to shrink `rivers.js`. `MAIN_STEMS` and `STATIONS`
in the script list the traced rivers and the gauges.
