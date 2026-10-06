# Time axis

A run has three nested time levels:

- **Model steps.** The run period is cut into equal steps of length T = `model_step`
  (for example one day). Your script supplies runoff once per model step; each call
  to `model.step_advance()` simulates one model step.
- **Sub-steps.** Inside each model step the solver takes N equal steps of length
  dt = T/N, short enough for the river equations to stay stable.
- **Statistics windows.** Sub-step results are aggregated over a window, for example
  a day, and optionally again over a longer window, for example a year. See
  [Statistics and output](statistics.md).

<figure class="fig">

--8<-- "figures/time-axis.svg"

<figcaption>Top: the whole run. Spin-up cycles replay the same period without output, then the main period starts. Middle: March 2000 as 31 daily model steps; each day gets one runoff value, held flat, and one daily mean of <code>total_outflow</code> (inner window). Bottom: the records written, one per day for <code>mean</code> and one per month for <code>max_mean</code> (outer window). How a single day is solved is shown in the next figure.</figcaption>
</figure>

## The schedule

The **schedule** lists all model steps of a run with their dates. The runoff dataset
builds it from `start_date`, `end_date` (included), `model_step` and the spin-up
settings; pass it to the model:

```python
dataset = DailyBinDataset(base_dir=..., start_date=datetime(2000, 1, 1),
                          end_date=datetime(2000, 12, 31),
                          model_step=timedelta(days=1), ...)
model = CaMaFlood(..., simulation_schedule=dataset.simulation_schedule)
```

Each entry covers the half-open interval `[start, end)` and is marked as spin-up or
main period. For 2000-01-01 to 2000-12-31 with `model_step=timedelta(days=1)`, the
schedule has 366 model steps.

**Spin-up** brings river and floodplain storage to a realistic state before the
period you analyse. Each spin-up cycle replays `spin_up_start_date` to
`spin_up_end_date`; all cycles run before the main period, and the water state
carries over into it. Statistics, output files and the log start with the first
step of the main period.

`step_advance()` takes no date or step length: each call runs the next schedule
entry and then advances the model's date by that entry's length.

## Model steps and forcing

Before each `step_advance()`, give the model that step's runoff with
`set_inputs()`. The scripts read the runoff in **chunks** (one or more records each)
through a PyTorch `DataLoader`, then step through the records of each chunk:

```python
reuse_count = dataset.time_interval // dataset.model_step
for runoff_chunk in loader:                      # one chunk of records
    ...                                          # move to the GPU, map to catchments
    for runoff in runoff_chunk:
        model.set_inputs(runoff=runoff)          # copy forcing for this record
        for _ in range(reuse_count):
            model.step_advance(num_sub_steps=num_sub_steps)
```

Call `set_inputs()` between model steps. `runoff` is a **rate in m³/s per
catchment**, already mapped from the grid
([Runoff mapping](../inputs/runoff-mapping.md)). The model holds it constant for the
whole model step: every sub-step adds `runoff × dt`, split between river and
floodplain by the flooded fraction, so the step receives `runoff × T`. Supply the
**mean rate over the step's interval `[start, end)`**. For accumulated products the
dataset does this for you: the ERA5-Land script de-accumulates the hourly runoff and
converts it with `source_units="m"`, `target_units="m s-1"` and `unit_factor=3600`
(seconds per record); record t covers `[t, t+Δt)`.

`model_step` must divide the runoff record spacing (`time_interval`) and must not
exceed it. If it is shorter, one record covers `reuse_count = time_interval ÷
model_step` model steps and the dataset needs `upsampling="repeat"` (reuse the
record) or `"distribute"` (divide each record by `reuse_count` when it is read); the
loop above then calls `step_advance()` `reuse_count` times per record. If the two are
equal, `upsampling` must stay `None`. See [Runoff datasets](../inputs/datasets.md).

## Sub-steps

<figure class="fig">

--8<-- "figures/substeps.svg"

<figcaption>One model step, sliced into sub-steps: a day is split into N equal sub-steps; the runoff is applied as a constant mean rate throughout, and statistics are updated after every sub-step.</figcaption>
</figure>

Each sub-step computes, in this order:

> outflow → (reservoir) → (bifurcation / levee-bifurcation) → inflow →
> (bifurcation inflow) → storage & flood stage → (levee stage)

Steps in parentheses run when their module is in `opened_modules`.

!!! hydroforge "Powered by HydroForge"
    HydroForge passes your `opened_modules` to the GPU compiler as constants, so the code of switched-off modules is compiled out of each kernel instead of being tested at every sub-step.

The sub-step length is limited by the **CFL condition**: in one sub-step a flood wave
must travel no further than about one river reach. Waves travel faster in deeper
water, so high rivers need shorter sub-steps. Choose N in one of two ways:

- **Fixed**: `step_advance(num_sub_steps=N)`. The example script uses N = 360 for
  a daily step, which gives dt = 240 s.
- **Adaptive** (`adaptive_time` module on): pass `num_sub_steps=None`. At the start
  of every model step the model computes each catchment's longest stable sub-step,
  `dt_i = 0.7·Δx_i / sqrt(g·max(h_i, 0.01))`, where Δx_i is the distance to the
  next catchment, g gravity and h_i the river depth. N is the number of sub-steps
  the most demanding catchment on any GPU needs, and dt = T/N for the whole outer
  step. N can change between model steps.

## Statistics windows

Set statistics windows with a `StatisticsPlan` from `hydroforge.contracts` and pass
it in the model's `OutputConfig`:

```python
from hydroforge.contracts import CalendarWindow, EveryStep, StatisticsPlan
from hydroforge.model import OutputConfig

statistics_plan = StatisticsPlan(
    inner=CalendarWindow(period="day"),    # default inner: EveryStep()
    outer=CalendarWindow(period="year"),
    partial_period="close",
)
model = CaMaFlood(..., output=OutputConfig(..., statistics_plan=statistics_plan))
```

Window types:

- `EveryStep()`: one result per model step (default inner window).
- `CalendarWindow(period="day" | "month" | "year")`: calendar days, months or years.
- `ExplicitWindows(...)`: windows you list yourself.

The **inner window** collects the sub-step values of all model steps inside it, for
example all sub-steps of one day. The optional **outer window** collects finished
inner-window results, for example the 365 daily means of a year; two-level
statistics such as the annual maximum of daily means (`max_mean`) need it. Outer
steps must not cross a window boundary: a daily inner window needs a `model_step`
of one day or less, aligned to calendar days.

**Time stamps.** Each record is stamped with the **start** of its inner window, in
`days since 1900-01-01 00:00:00` and the schedule's calendar. A two-level result
carries the start of the *last* inner window of its outer window: an annual
`max_mean` for 1999 is stamped 1999-12-31. If the run ends mid-window,
`partial_period="close"` writes the incomplete window at the end; `"drop"` skips the
incomplete last outer window, including the inner-window records inside it.

## Interactive timeline

Drag the strip or press Play to follow a short run step by step: spin-up and main
period, the model steps and their sub-steps, the statistics windows, and which
`DataLoader` worker reads which runoff chunk. With `loader_workers > 0`, PyTorch
requests `loader_workers × prefetch_factor` chunks ahead, hands chunk i to worker
i mod `loader_workers`, and requests one more each time the loop takes a chunk.
Durations and values in the widget are illustrative; the order of events follows the
code.

<div class="cmf-timeline" data-view="time-axis" data-preset="daily" data-search-exclude markdown="0">
<noscript>The interactive timeline needs JavaScript. The figure at the top of this page shows the same time levels.</noscript>
</div>

See [Statistics and output](statistics.md) for the operations,
[Output files](../outputs/output-files.md) for the NetCDF files and
[Configuration](configuration.md) for all constructor keywords.
