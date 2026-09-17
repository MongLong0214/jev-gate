export function createSearchClient(fetchResults) {
  const state = { query: '', results: [] };

  async function search(query) {
    state.query = query;
    const items = await fetchResults(query);
    state.results = items;
    return { query, items };
  }

  return {
    search,
    getState: () => ({ query: state.query, results: [...state.results] }),
  };
}
