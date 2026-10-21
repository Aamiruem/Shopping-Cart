// Keeps the last few viewed products in localStorage for the home page rail
const KEY = 'recently-viewed';
const MAX = 12;

export function getRecentlyViewed() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

export function addRecentlyViewed(product) {
  const { _id, name, image, price, mrp, rating, ratingCount, brand, stock } = product;
  const next = [{ _id, name, image, price, mrp, rating, ratingCount, brand, stock }, ...getRecentlyViewed().filter((p) => p._id !== _id)];
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX)));
  } catch {
    /* storage full or blocked - not critical */
  }
}
