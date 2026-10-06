# Statistics and output

## Compute statistics while the model runs

Declare the **statistics** you need, such as the daily mean discharge, and the
model computes them during the run. Saving raw fields would leave the GPU waiting
for the disk: `glb_15min` has 252,383 catchments, and the model takes hundreds of
sub-steps (see [Time axis](time-axis.md#sub-steps)) per simulated day.

- For each requested variable and operation, the model keeps a running total (an
  *accumulator*) on the GPU and updates it after every sub-step. This costs almost
  nothing.
- Accumulators exist for the **saved points**, the catchments whose results are
  written (all catchments by default).
- Finished results leave the GPU once per statistics window, for example once per
  day.

!!! hydroforge "Powered by HydroForge"
    HydroForge generates the statistics kernels for Triton, CUDA and Metal from a single description of each operation, so every backend runs the same sequence of updates. Two-level operations such as `max_mean` fold each finished inner window into its outer window on the GPU, so the inner results never leave the device.

<figure class="fig">

--8<-- "figures/statistics.svg"

<figcaption>How output flows. Your selection (the <code>variables</code> of <code>OutputConfig</code>, expressions and the saved catchments) decides what the accumulators on the GPU track. Only finished window results move to the CPU, where background processes write them. Bottom: the data volume on the GPU (C catchments × N sub-steps per day) compared with the volume on disk (S saved points × one record per window).</figcaption>
</figure>

## Saving runs in the background

The GPU keeps simulating while background CPU processes compress finished results
and write them to disk. When a statistics window closes, its results are copied
off the GPU into a buffer on the CPU, one row per output file.

- `output_workers` in the scripts, passed as `OutputConfig(workers=...)`, sets the
  number of writer processes per rank (default 2). Each output file always goes to
  the same writer; the files are spread over the writers.
- Rows are collected in batches of up to 30 per file and a full batch is handed to
  that file's writer. With `0` writers the model appends each full batch itself and
  waits.
- `max_pending_steps` (default 200) bounds how many finished rows per file may wait
  for their writer. Smaller values give smaller batches; when every buffer of a file
  is still being written, the model pauses until the writer catches up.
- Leaving the `with model:` block (or calling `model.close()`) writes the partly
  filled batches and waits until every result is on disk.

!!! hydroforge "Powered by HydroForge"
    HydroForge keeps that CPU buffer in shared memory that the writer processes read directly, so the model hands a writer only a small descriptor per batch, never the rows themselves. From a CUDA GPU the copy into the buffer can run asynchronously, without the model waiting for it.

## Declaring statistics

Map each operation to a list of variables. The scripts keep this mapping in
`variables_to_save` and pass it as `OutputConfig(variables=...)`:

```python
variables_to_save = {
    "mean": ["total_outflow"],
    "last": ["river_depth"],
}
model = CaMaFlood(..., output=OutputConfig(..., variables=variables_to_save))
```

`OutputConfig(statistics_plan=...)` sets the **statistics windows**, the periods over which results
are aggregated (see [Time axis](time-axis.md#statistics-windows)). The operation
sets what is computed over the sub-steps of each window:

| operation | result for each window |
|---|---|
| `mean` | time-weighted mean (each sub-step weighted by its length dt) |
| `sum` | time integral Σ value·dt, in seconds × the variable's unit (m³ s⁻¹ becomes m³). The `description` attribute in the file still shows the rate unit. |
| `max`, `min` | largest / smallest sub-step value |
| `first`, `last` | value at the first / last sub-step of the window |

### Two-level statistics

"The monthly maximum of daily-mean discharge" takes a mean over each day (the
**inner** window), then the maximum of those means over each month (the **outer**
window). Write it as `<outer>_<inner>`, here `max_mean`. Two levels is the limit.
Set the outer window with `outer=` in the `StatisticsPlan`; without it the outer
window equals the inner one, so each compound result covers a single inner window.

| operation | meaning |
|---|---|
| `max_mean` | largest inner-window mean within each outer window, e.g. the monthly maximum of daily-mean discharge |
| `mean_mean`, `min_mean`, `sum_mean`, `first_mean`, `last_mean` | the same pattern with another outer operation; the outer `mean` is a plain average of the inner values |

`max` and `min` have two more variants, combined with an inner operation. They work
for variables with one value per saved point, not for variables with extra levels
such as bifurcation channels:

- `max3_mean` gives the 3 largest inner-window means of each outer window, written
  to three files ending in `_0`, `_1` and `_2`.
- `argmax_mean` gives the 0-based position of the largest inner window within the
  outer window. With daily inner and monthly outer windows, 0 means the peak fell
  on the first day of the month.

### Example: monthly maximum of daily-mean discharge

```python
from hydroforge.contracts import CalendarWindow, StatisticsPlan
from hydroforge.model import OutputConfig

model = CaMaFlood(
    ...,
    output=OutputConfig(
        ...,
        statistics_plan=StatisticsPlan(
            inner=CalendarWindow(period="day"),
            outer=CalendarWindow(period="month"),
        ),
        variables={
            "max_mean": ["total_outflow"],   # monthly max of daily-mean discharge
            "mean_mean": ["total_outflow"],  # monthly mean of daily means
        },
    ),
)
```

A run over 2000 writes `total_outflow_max_mean_rank0.nc` and
`total_outflow_mean_mean_rank0.nc` with one record per month. Each record is
stamped with the start of the last day of its month, e.g. 2000-01-31 for January
(see [Time axis](time-axis.md#statistics-windows)). A daily inner window requires
a model step (`model_step`) of one day or less. For annual extremes, use
`outer=CalendarWindow(period="year")`.

### Derived expressions

To save a quantity computed from model variables, give it a name and a formula.
The formula is evaluated on the GPU:

```python
variables_to_save = {"mean": ["total_outflow", {"above_bank": "river_depth - river_height"}]}
```

`above_bank` is the water level above the top of the river bank, in m (negative
below bankfull). The output file takes the name you chose:
`above_bank_mean_rank0.nc`.

Formulas may use `+ - * / % **`, comparisons, `and`/`or`/`not`, the conditional
`a if cond else b`, the functions
`abs sqrt exp log sin cos tan pow maximum minimum where`, and `pi`. Forcing
variables such as `runoff` cannot appear in formulas.

## Watch statistics and output in a run

Drag the strip or press Play. The widget accumulates illustrative discharge over the
sub-steps of each inner window, writes a record when the window closes (stamped with
the window start), folds daily means into `max_mean` until the outer window closes,
and fills each file's batches until its writer appends them. Durations and values
are illustrative; the rules follow the code.

<div class="cmf-timeline" data-view="statistics" data-preset="annual" data-search-exclude markdown="0">
<noscript>The interactive timeline needs JavaScript. The figure at the top of this page shows how results flow from the GPU to the writers.</noscript>
</div>

## Variables you can save

The most useful variables are below. See
[Model variables](../reference/variables.md) for the full list, module by module.

Computed from other variables:

| name | definition | unit |
|---|---|---|
| `total_outflow` | `river_outflow + flood_outflow` | m³ s⁻¹ |
| `water_surface_elevation` | `river_depth + catchment_elevation − river_height` | m |
| `flood_area` | `flood_fraction × catchment_area` | m² |

Base-module variables (names as in `cmfgpu/modules/base.py`; full list in [Variables](../reference/variables.md)):

| name | meaning | unit |
|---|---|---|
| `river_outflow` | flow out of the river channel | m³ s⁻¹ |
| `flood_outflow` | flow out of the floodplain | m³ s⁻¹ |
| `river_inflow` | total inflow into the river channel | m³ s⁻¹ |
| `flood_inflow` | total inflow to the floodplain | m³ s⁻¹ |
| `river_depth` | river water depth | m |
| `flood_depth` | floodplain water depth above bankfull | m |
| `river_storage` | water volume in the river channel | m³ |
| `flood_storage` | water volume on the floodplain | m³ |
| `total_storage` | river + floodplain (+ levee-protected) storage | m³ |
| `flood_fraction` | fraction of the catchment area that is flooded | – |

Other modules add their own variables, such as the flow through each bifurcation
channel. Variables with several levels per point are written with an extra
`levels` dimension. The runoff forcing cannot be saved.

## Saving only chosen catchments

**Regional saving** writes results only for the catchments you choose, for
example gauged catchments or one region. The simulation still covers the whole
domain. Because accumulators exist only for the saved points, a small selection
also saves GPU memory and shrinks every transfer to the CPU.

The selection is `output_catchment_id` in the model input file (dimension
`saved_points`); by default it lists every catchment. Change it at run time without
rebuilding the file:

```python
input_proxy = InputProxy.from_nc(input_file)
input_proxy = input_proxy.updated(
    values={"output_catchment_id": selected_ids}   # int64 array of catchment_id
)
```

or set it when building the file, with
`MERITMap(only_save_pois=True, points_of_interest={"gauges": "all"})` (see
[River network and parameters](../inputs/model-input.md)). Bifurcation channels
have their own selection, `output_bifurcation_path_id` (default: all channels).

There is no latitude–longitude box option. Pick the catchment ids yourself, for
example from the `longitude`/`latitude` or gauge variables in the model input file.

Statistics start with the first step of the main period; nothing is accumulated
during spin-up.
