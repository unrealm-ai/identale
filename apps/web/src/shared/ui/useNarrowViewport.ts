import {onUnmounted,ref} from 'vue';
export function useNarrowViewport(){const query=window.matchMedia('(max-width:760px)'),narrow=ref(query.matches),update=()=>narrow.value=query.matches;query.addEventListener('change',update);onUnmounted(()=>query.removeEventListener('change',update));return narrow;}
