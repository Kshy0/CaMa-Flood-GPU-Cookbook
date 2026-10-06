# River network and parameters

The model reads one NetCDF file, `parameters.nc` by default, that describes the rivers:

- the **river network**: which catchment drains into which, and how catchments are
  grouped into basins;
- the **parameters**: channel and floodplain geometry, plus optional levee, dam and
  bifurcation data;
- the **initial state**: the water in rivers and floodplains at the start.

Build it once per CaMa-Flood map resolution with the `MERITMap` builder. Load it in
every run with `InputProxy.from_nc(...)`.

<figure class="fig">

--8<-- "figures/parameters-flow.svg"

<figcaption>Build once, load every run: <code>make_map_params.py</code> turns the CaMa map files into <code>parameters.nc</code>; at run time the model keeps the variables of the modules you switched on, splits the basins between GPUs and copies the data to each GPU.</figcaption>
</figure>

## Building the file

Run `scripts/make_map_params.py` on a CaMa map folder such as
`cmf_v420_pkg/map/glb_15min`:

```python
from cmfgpu.params import MERITMap

MERITMap(
    map_dir=".../cmf_v420_pkg/map/glb_15min",
    out_dir=".../inp/glb_15min",
    bifori_file=".../map/glb_15min/bifori.txt",      # or None
    gauge_file=".../map/glb_15min/GRDC_alloc.txt",   # or None
    bif_levels_to_keep=5,
    target_gpus=4,
    out_file="parameters.nc",
).build_input()
```

The options you are most likely to change:

| option | what it does |
|---|---|
| `bifori_file` | Bifurcation file (`bifori.txt`). `None` writes no bifurcation channels. |
| `bif_levels_to_keep` | Elevation levels kept per bifurcation channel (default 5). |
| `gauge_file` | Gauge list such as `GRDC_alloc.txt`. Each gauge goes to the catchment with the smallest allocation error. Stored for reference; the model does not read it. |
| `target_gpus` | Number of GPUs you plan to use. It tunes basin merging and prints a load-balance report; it does not limit the GPUs at run time. |
| `basin_merge_rate` | How strongly basins are merged (default `"auto"`). |
| `levee_flag` | Read the levee maps `levhgt.bin` and `levfrc.bin`. |
| `reservoir_flag`, `dam_file` | Read a dam table (CSV). Volumes are converted from million m³ to m³. |
| `satellite_width_file` | Satellite river-width map, stored for `update_river_params.py`. |
| `points_of_interest`, `only_save_pois` | Restrict the domain, or the saved catchments, to chosen gauges, grid cells or catchments: `{"gauges": "all" \| [...], "coords": [(x, y)], "catchments": [...]}`. |

### What the builder does

The builder numbers the catchments, attaches gauges, prunes the bifurcation
channels, keeps the basins you asked for, reads the parameters, checks the flow
directions, computes an initial river depth and writes the NetCDF file. It writes
to a temporary name and renames at the end, so an interrupted build leaves no
partial file.

Two properties of the result matter later:

- **Catchments run from upstream to downstream.** Every catchment comes before the
  catchment it drains into. Basins run from largest to smallest.
- **Connected basins stay together.** Each catchment carries a basin number
  (`catchment_basin_id`). Basins linked by a bifurcation channel share a number, so
  a multi-GPU run keeps them on one GPU.

The initial state is filled by sweeping upstream from the river mouths: first
`river_depth`, then `river_storage = river_length × river_width × river_depth`.

## Updating an existing file

Two scripts refine a file you have built:

- `scripts/update_river_params.py` estimates river width and bankfull depth from a
  runoff climatology (`estimate_river_geometry`). Width and depth follow power laws
  of the long-term discharge, optionally blended with satellite widths. It rewrites
  `river_width`, `river_height`, `river_depth`, `river_storage` and the lowest
  bifurcation elevation, and writes `parameters_new.nc` or updates the file in
  place.
- `scripts/update_dam_params.py` estimates reservoir parameters
  (`estimate_dam_params`), adds them with a `reservoir` dimension and writes
  `parameters_dam.nc`.

## Which map files are read

All CaMa map binaries live in `map_dir` as little-endian 4-byte integers or floats
in Fortran order.

| map file | stored as |
|---|---|
| `mapdim.txt` | grid size `nx`, `ny` and the number of flood levels |
| `nextxy.bin` | catchment ids, downstream ids, river mouths and grid positions |
| `rivlen.bin` | `river_length` |
| `rivwth_gwdlr.bin` (optional) | `river_width` |
| `rivhgt.bin` (optional) | `river_height` |
| `width.bin` (optional, satellite) | `satellite_width` |
| `elevtn.bin` | `catchment_elevation` |
| `ctmare.bin` | `catchment_area` |
| `uparea.bin` | `upstream_area` |
| `nxtdst.bin` | `downstream_distance` (10 000 m at river mouths) |
| `lonlat.bin` (optional) | `longitude`, `latitude` |
| `fldhgt.bin` | `flood_depth_table` (made non-negative and non-decreasing) |
| `levhgt.bin`, `levfrc.bin` (with `levee_flag`) | `levee_crown_height`, `levee_fraction` |
| `bifori.txt` | the bifurcation channels |
| `GRDC_alloc.txt` (`gauge_file`) | the gauge list |
| dam CSV (with `reservoir_flag`) | the reservoir parameters |

A catchment id is the 0-based grid position `ix * ny + iy`, the same numbering as
in the output files.

## What the file contains

For the `glb_15min` map the file has these dimensions:

| dimension | size | counts |
|---|---|---|
| `catchment` | 252,383 | unit catchments |
| `basin` | 21,952 | river basins after merging |
| `flood_level` | 10 | levels of the floodplain depth table |
| `bifurcation_path` | 17,242 | bifurcation channels |
| `bifurcation_level` | 5 | elevation levels per bifurcation channel |
| `gauge` | 5,792 | gauges from the gauge list |
| `saved_points` | 252,383 | catchments whose results are saved (all by default) |

Global attributes: `title`, `history`, `nx=1440`, `ny=720`, `num_basins=21952`.
Ids are 64-bit integers; physical values are 32-bit floats. Levee and reservoir
variables, with their own dimensions `levee` and `reservoir`, appear when you build
with them.

### Variables and where they come from

These are the variables the model reads. A variable marked "default" may be absent;
the model then uses the value shown. For the full list by module, see
[Model variables](../reference/variables.md).

**River network**

| variable | meaning | unit | source |
|---|---|---|---|
| `catchment_id` | id of each catchment | – | position in `nextxy.bin` |
| `downstream_id` | id of the catchment it drains into (itself at a river mouth) | – | `nextxy.bin` |
| `catchment_basin_id` | basin number, keeps a basin on one GPU | – | computed by the builder |
| `output_catchment_id` | catchments whose results are saved | – | all catchments, or your points of interest |

**Channel and floodplain parameters**

| variable | meaning | unit | source |
|---|---|---|---|
| `river_length` | channel length | m | `rivlen.bin` |
| `river_width` | channel width | m | `rivwth_gwdlr.bin` or `update_river_params.py` |
| `river_height` | bankfull depth | m | `rivhgt.bin` or `update_river_params.py` |
| `catchment_elevation` | mean ground elevation | m | `elevtn.bin` |
| `catchment_area` | catchment area | m² | `ctmare.bin` |
| `downstream_distance` | distance to the next catchment downstream | m | `nxtdst.bin` |
| `flood_depth_table` | floodplain depth at each flooded-area fraction (one value per flood level) | m | `fldhgt.bin` |
| `river_manning` | channel roughness | s m⁻¹ᐟ³ | default 0.03 |
| `flood_manning` | floodplain roughness | s m⁻¹ᐟ³ | default 0.1 |

**Initial state**

| variable | meaning | unit | source |
|---|---|---|---|
| `river_depth` | river water depth | m | upstream sweep, or `update_river_params.py` |
| `river_storage` | river water volume | m³ | length × width × depth |
| all other state variables | floodplain storage and depth, outflows, … | – | default 0 |

**Bifurcation channels** (with `bifori_file`)

| variable | meaning | unit | source |
|---|---|---|---|
| `bifurcation_path_id` | id of each channel | – | `bifori.txt` |
| `bifurcation_catchment_id`, `bifurcation_downstream_id` | catchments at the upstream and downstream end | – | `bifori.txt` |
| `bifurcation_length` | channel length | m | `bifori.txt` |
| `bifurcation_width` | width per level | m | `bifori.txt` |
| `bifurcation_elevation` | bed elevation per level | m | `bifori.txt` |
| `bifurcation_manning` | roughness per level | s m⁻¹ᐟ³ | `bifori.txt` |

**Levees** (with `levee_flag`)

| variable | meaning | unit | source |
|---|---|---|---|
| `levee_id`, `levee_catchment_id` | levee id and the catchment it protects | – | `levhgt.bin`, `levfrc.bin` |
| `levee_crown_height` | crown height above the river bed | m | `levhgt.bin` |
| `levee_fraction` | levee position, from 0 (at the channel) to 1 (far edge of the catchment) | – | `levfrc.bin` |

**Reservoirs** (with `reservoir_flag` or `update_dam_params.py`)

| variable | meaning | unit | source |
|---|---|---|---|
| `reservoir_id`, `reservoir_catchment_id` | dam id and the catchment it sits in | – | dam CSV |
| `reservoir_capacity`, `conservation_volume`, `emergency_volume` | total, conservation and emergency storage | m³ | dam CSV (converted from million m³) |
| `normal_outflow`, `flood_control_outflow` | normal and flood-control release | m³ s⁻¹ | dam CSV |
| `reservoir_area` | surface area at normal water level | m² | dam CSV |
| `reservoir_total_inflow` | inflow to the dam, part of the initial state | m³ s⁻¹ | usually absent; see below |

**Map metadata**, written for your reference and ignored by the model: `nx`, `ny`,
`num_basins`, the grid position of each catchment (`catchment_x`, `catchment_y`)
and of each bifurcation end, `river_mouth_id`, `catchment_mainstem_basin_id`,
`basin_sizes`, `upstream_area`, `longitude`, `latitude`, `satellite_width` and the
gauge variables (`gauge_catchment_id`, `gauge_station_id`,
`gauge_reported_area_km2`, `gauge_allocated_area_km2`, `gauge_alloc_error`).

Runoff is not in the file; you supply it at every time step. The `adaptive_time`
and `log` modules need nothing from the file. The `sea_level` and `inflow` modules
need the catchments they act on (`sea_level_catchment_id`, `inflow_catchment_id`),
which `MERITMap` does not write, and receive their data at every time step.

## How the model reads the file

1. **Loading.** `InputProxy.from_nc(path)` opens the file. Pass a list of files to
   combine them; a variable that appears twice, or a dimension with two sizes, is
   an error.
2. **Selection.** The model keeps the variables of the modules you switch on with
   `opened_modules` in `CaMaFlood(...)` and ignores map metadata and gauges. A
   missing required variable raises a `KeyError`.
3. **Categories.** Each variable is river network, parameter, initial state,
   forcing (supplied every time step, not read from the file) or derived (computed
   on the GPU after loading). See [Model variables](../reference/variables.md).
4. **Splitting between GPUs.** Whole basins are handed out largest first, each to
   the GPU with the least work so far. Bifurcation channels, levees and dams follow
   their catchment. On each GPU the catchments stay in upstream-to-downstream order.
5. **Precision.** Physical values use the model precision (32-bit floats by
   default). With mixed precision, the default on NVIDIA, AMD and Apple GPUs, water
   volumes are kept in double precision (see
   [Choosing a backend](../install.md#choosing-a-backend) for Metal). Ids are
   64-bit integers.
6. **Checks.** At load time the model checks that geometry and roughness are
   positive, elevations are finite, the flood depth table does not decrease and the
   initial state is not negative. If `reservoir_total_inflow` is absent, the run is
   a cold start and each dam starts at its conservation volume.
7. **Checkpoints.** `model.save_state()` writes the river network, parameters and
   current state of the switched-on modules in the same layout as this file,
   without map metadata and global attributes. See
   [Checkpoint and restart](../outputs/checkpoint.md).

!!! hydroforge "Powered by HydroForge"
    HydroForge splits by whole basins (`catchment_basin_id`), so no river crosses a GPU boundary. Each GPU then runs its sub-steps without exchanging any data with the others.

Next: [Runoff mapping](runoff-mapping.md) and [Runoff datasets](datasets.md).
