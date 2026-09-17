export function createSearchClient(fetchResults) {
  const state = { query: '', results: [] };
  let latest = 0;

  async function search(query) {
    const mine = ++latest;
    state.query = query;
    const items = await fetchResults(query);
    if (mine === latest) state.results = items;
    return { query, items };
  }

  return {
    search,
    getState: () => ({ query: state.query, results: [...state.results] }),
  };
}
