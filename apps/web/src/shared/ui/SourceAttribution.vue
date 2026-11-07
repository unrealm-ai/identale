<script setup lang="ts">
// Default project attribution. This UI is not an additional license condition.
</script>

<template>
  <footer class="source-attribution" aria-label="项目来源与许可">
    <div class="source-attribution__line">
      <a href="https://github.com/unrealm-ai/identale" target="_blank" rel="noopener noreferrer">identale</a>
      <span aria-hidden="true">·</span>
      <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">Apache-2.0</a>
    </div>
    <details class="source-attribution__details">
      <summary>许可说明</summary>
      <p>第三方软件、图片及商标保留各自许可与权利；完整说明随源码中的 NOTICE 和 THIRD_PARTY_NOTICES.md 提供。</p>
    </details>
  </footer>
</template>

<style scoped>
.source-attribution__line{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem}
.source-attribution a{color:inherit;text-decoration:underline;text-underline-offset:.18em;overflow-wrap:anywhere}
.source-attribution a:hover{color:var(--text)}
.source-attribution a:focus-visible,.source-attribution summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.source-attribution__details{margin-top:.25rem;max-width:48rem}
.source-attribution summary{cursor:pointer;width:fit-content}
.source-attribution p{margin:.5rem 0 0;overflow-wrap:anywhere}
</style>
