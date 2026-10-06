# CaMa-Flood-GPU

CaMa-Flood-GPU is a GPU re-implementation of the [CaMa-Flood](https://github.com/global-hydrodynamics/CaMa-Flood_v4)
global river and floodplain model, written in Python on PyTorch. It runs on NVIDIA
(CUDA), AMD (ROCm) and Apple (Metal) GPUs, on Linux, Windows and macOS. It reads
CaMa-Flood v4 map files and splits a run over several GPUs by giving each GPU a set
of whole river basins.

New to CaMa-Flood? Run the original Fortran model once first to learn the map and
input conventions this version reuses.

## Workflow

1. [Install](install.md) PyTorch for your GPU, the HydroForge framework and the
   `cmfgpu` package.
2. Build the model input file (river network, parameters and initial state) from a
   CaMa-Flood map: [River network and parameters](inputs/model-input.md).
3. Build the table that turns gridded runoff into runoff per catchment:
   [Runoff mapping](inputs/runoff-mapping.md).
4. Pick a reader for your runoff files, or convert them once to a faster format:
   [Runoff datasets](inputs/datasets.md).
5. Configure and launch a run: [Time axis](run/time-axis.md),
   [Statistics and output](run/statistics.md), [Configuration](run/configuration.md).
6. Read the results and restart from saved states:
   [Output files](outputs/output-files.md), [Checkpoint and restart](outputs/checkpoint.md).

All model variables are listed on [Model variables](reference/variables.md).
A [community benchmark](benchmark.md) of user measurements is in preparation.

## Key terms

| term | meaning |
|---|---|
| catchment | A CaMa-Flood unit catchment: one river reach with its floodplain. The basic cell of the model. |
| model step | One model time step as seen from your script, for example one day. Runoff is supplied once per model step. |
| sub-step | The shorter solver steps inside one model step, for numerical stability. |
| CFL condition | The stability rule that limits sub-step length: a flood wave may travel at most about one river reach per sub-step. Deeper water moves faster and needs shorter sub-steps. |
| schedule | All model steps of a run (dates and durations), built from your start and end dates. |
| spin-up | Extra simulated years before the period of interest, so river and floodplain storage reach a realistic state. |
| saved points | The catchments whose results are written to disk. Default: every catchment. |
| backend | The technology that generates the GPU code: Triton, CUDA or Metal. |
| rank | One process in a multi-GPU run. Each rank drives one GPU and its own basins. |
| mixed precision | Most numbers are 32-bit floating point; water volumes are kept in double precision so small changes survive rounding. On by default on GPUs. |
| checkpoint | A file with the complete model state at one moment, used to restart a run. |
| statistics window | The period over which results are aggregated before they are written. Statistics have two levels of windows. |
| inner window | Collects the sub-step values of the model steps inside it: every model step (`EveryStep()`, the default), a calendar day, month or year (`CalendarWindow`), or named periods (`ExplicitWindows`). `mean`, `max`, `last` and the other simple operations give one result per inner window. |
| outer window | Folds the finished inner results again, for example the maximum of the daily means within each year (`max_mean`). Its boundaries fall on inner-window boundaries; without one, the outer window equals the inner window. |

!!! hydroforge "Built on HydroForge"
    CaMa-Flood-GPU is a model written on [HydroForge](https://github.com/Kshy0/hydroforge),
    a framework for hydrological models on GPUs. HydroForge generates the Triton, CUDA
    and Metal kernels, splits a run over GPUs, handles the time axis and the statistics
    windows, and writes the output files.

## Citation

If you use CaMa-Flood-GPU in your research, cite:

**APA**

Kang, S., Yin, J., & Yamazaki, D. (2026). CaMa-Flood-GPU: A GPU-based hydrodynamic
model implementation for scalable global simulations. *Geoscientific Model
Development, 19*(12), 5623–5640. <https://doi.org/10.5194/gmd-19-5623-2026>
([article page](https://gmd.copernicus.org/articles/19/5623/2026/))

**BibTeX**

```bibtex
@article{kang2026camafloodgpu,
  author  = {Kang, Shengyu and Yin, Jiabo and Yamazaki, Dai},
  title   = {CaMa-Flood-GPU: a GPU-based hydrodynamic model implementation for scalable global simulations},
  journal = {Geoscientific Model Development},
  year    = {2026},
  volume  = {19},
  number  = {12},
  pages   = {5623--5640},
  doi     = {10.5194/gmd-19-5623-2026},
  url     = {https://gmd.copernicus.org/articles/19/5623/2026/}
}
```
