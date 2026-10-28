<script lang="ts">
  import { onMount } from 'svelte';
  // A small ECharts host for overview summaries. The option is rebuilt by the parent;
  // the engine chunk is shared with panel plugins and loads on first use.
  let {
    option,
    height = 160,
    label,
  }: { option: any; height?: number; label: string } = $props();
  let host = $state<HTMLDivElement>();
  let chart: any;
  onMount(() => {
    let disposed = false,
      observer: ResizeObserver | undefined;
    void import('./plugins/engine').then(({ echarts }) => {
      if (disposed || !host) return;
      chart = echarts.init(host, undefined, { renderer: 'canvas' });
      chart.setOption(option, true);
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(host);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.dispose();
      chart = undefined;
    };
  });
  $effect(() => {
    const next = option;
    chart?.setOption(next, true);
  });
</script>

<div class="overview-chart" role="img" aria-label={label} bind:this={host} style:height={height + 'px'}></div>

<style>
  .overview-chart {
    width: 100%;
    min-width: 0;
  }
</style>
