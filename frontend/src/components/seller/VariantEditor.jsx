import { useState } from 'react';
import { COLOR_SWATCHES } from '../../constants/colors';
import Icon from '../common/Icon';

// Sizes and colours for the seller's product form. Sizes are free text with one-click presets; each colour has a
// name, a swatch (colour picker) and, optionally, which of the product's photos shows that colour.
const PRESETS = [
  { label: 'Clothing', sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'] },
  { label: 'Shoes (UK)', sizes: ['5', '6', '7', '8', '9', '10', '11'] },
  { label: 'Waist', sizes: ['28', '30', '32', '34', '36', '38', '40'] },
  { label: 'Free Size', sizes: ['Free Size'] },
];
const QUICK_COLORS = ['Black', 'White', 'Navy', 'Blue', 'Red', 'Maroon', 'Green', 'Grey', 'Beige', 'Pink', 'Yellow', 'Brown'];
const knownHex = (name) => {
  const v = COLOR_SWATCHES[name.trim().toLowerCase()];
  return v?.startsWith('#') ? v : '#888888';
};

/** Form state from a saved product. */
export const variantsFromProduct = (p) => ({
  sizes: p.sizes || [],
  colors: (p.colors || []).map((name) => ({ name, hex: p.colorHex?.[name] || knownHex(name), image: p.colorImages?.[name] || '' })),
});

/** The API body fields from the form state. */
export function variantsBody({ sizes, colors }, images) {
  const named = colors.filter((c) => c.name.trim());
  return {
    sizes,
    colors: named.map((c) => c.name.trim()),
    colorHex: Object.fromEntries(named.map((c) => [c.name.trim(), c.hex])),
    colorImages: Object.fromEntries(named.filter((c) => c.image && images.includes(c.image)).map((c) => [c.name.trim(), c.image])),
  };
}

/** A problem to show before saving, or ''. */
export function variantsProblem({ colors }) {
  const names = colors.map((c) => c.name.trim().toLowerCase()).filter(Boolean);
  if (colors.some((c) => !c.name.trim())) return 'Give every colour a name (or remove it)';
  if (new Set(names).size !== names.length) return 'Each colour can be listed only once';
  return '';
}

export default function VariantEditor({ value, images, onChange }) {
  const [sizeInput, setSizeInput] = useState('');
  const { sizes, colors } = value;
  const setSizes = (next) => onChange({ ...value, sizes: [...new Set(next.map((s) => s.trim()).filter(Boolean))].slice(0, 20) });
  const setColors = (next) => onChange({ ...value, colors: next.slice(0, 20) });
  const addSize = () => {
    if (!sizeInput.trim()) return;
    setSizes([...sizes, ...sizeInput.split(',')]);
    setSizeInput('');
  };
  const addColor = (name = '') => {
    if (name && colors.some((c) => c.name.toLowerCase() === name.toLowerCase())) return;
    setColors([...colors, { name, hex: name ? knownHex(name) : '#888888', image: '' }]);
  };
  const editColor = (i, patch) => setColors(colors.map((c, n) => (n === i ? { ...c, ...patch } : c)));

  return (
    <div className="variant-editor">
      <section>
        <p className="field-label">Sizes <span className="muted small">(optional · shoppers must pick one before buying)</span></p>
        <div className="variant-presets">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="chip-btn" onClick={() => setSizes([...sizes, ...p.sizes])}>
              <Icon name="plus" size={12} /> {p.label}
            </button>
          ))}
          {sizes.length > 0 && <button type="button" className="chip-btn chip-btn-quiet" onClick={() => setSizes([])}>Clear</button>}
        </div>
        {sizes.length > 0 && (
          <ul className="variant-chips">
            {sizes.map((s) => (
              <li key={s}>
                {s}
                <button type="button" onClick={() => setSizes(sizes.filter((x) => x !== s))} aria-label={`Remove size ${s}`}><Icon name="x" size={12} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="variant-add">
          <input
            value={sizeInput}
            onChange={(e) => setSizeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSize();
              }
            }}
            maxLength={60}
            placeholder="Custom sizes, e.g. 6-12 months, 42, 75B"
            aria-label="Custom size"
          />
          <button type="button" className="btn btn-outline btn-sm" onClick={addSize} disabled={!sizeInput.trim()}>Add</button>
        </div>
      </section>

      <section>
        <p className="field-label">Colours <span className="muted small">(optional · pick the photo that shows each colour)</span></p>
        {colors.length > 0 && (
          <ul className="variant-colors">
            {colors.map((c, i) => (
              <li key={i}>
                <input type="color" value={c.hex} onChange={(e) => editColor(i, { hex: e.target.value })} aria-label={`Swatch for ${c.name || `colour ${i + 1}`}`} />
                <input value={c.name} onChange={(e) => editColor(i, { name: e.target.value })} maxLength={20} placeholder="Colour name" aria-label="Colour name" />
                <select value={c.image} onChange={(e) => editColor(i, { image: e.target.value })} aria-label={`Photo for ${c.name || `colour ${i + 1}`}`}>
                  <option value="">No specific photo</option>
                  {images.map((src, n) => <option key={src} value={src}>Photo {n + 1}{n === 0 ? ' (cover)' : ''}</option>)}
                </select>
                {c.image && images.includes(c.image) && <img src={c.image} alt="" />}
                <button type="button" className="icon-btn" onClick={() => setColors(colors.filter((_, n) => n !== i))} aria-label={`Remove ${c.name || 'colour'}`}><Icon name="trash" size={15} /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="variant-presets">
          {QUICK_COLORS.filter((q) => !colors.some((c) => c.name.toLowerCase() === q.toLowerCase())).slice(0, 8).map((q) => (
            <button key={q} type="button" className="chip-btn" onClick={() => addColor(q)}>
              <span className="chip-dot" style={{ background: knownHex(q) }} /> {q}
            </button>
          ))}
          <button type="button" className="chip-btn" onClick={() => addColor()}><Icon name="plus" size={12} /> Other colour</button>
        </div>
      </section>
    </div>
  );
}
