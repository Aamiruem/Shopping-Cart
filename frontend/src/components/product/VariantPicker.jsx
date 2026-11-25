import { useEffect, useRef, useState } from 'react';
import { COLOR_SWATCHES } from '../../constants/colors';
import Icon from '../common/Icon';

/** The swatch for a colour: the seller's code, a known name, or none (the name is always shown too). */
export const swatchOf = (product, color) => product.colorHex?.[color] || COLOR_SWATCHES[color.toLowerCase()] || null;

/** Whether the shopper still has to choose a size before buying. */
export const needsSize = (product, options) => Boolean(product.sizes?.length) && !options.size;

// Reference charts (cm for clothes, foot length for shoes). Brands differ, and the guide says so.
const APPAREL = {
  columns: ['Size', 'Chest', 'Waist', 'Length'],
  rows: [
    ['XS', '84–89', '69–74', '66'], ['S', '89–94', '74–79', '68'], ['M', '94–99', '79–84', '70'], ['L', '99–104', '84–89', '72'],
    ['XL', '104–109', '89–94', '74'], ['XXL', '109–114', '94–99', '76'], ['XXXL', '114–119', '99–104', '78'],
  ],
};
const BOTTOMS = {
  columns: ['Size', 'Waist', 'Hip', 'Inseam'],
  rows: [['28', '71', '89', '76'], ['30', '76', '94', '78'], ['32', '81', '99', '79'], ['34', '86', '104', '80'], ['36', '91', '109', '81'], ['38', '97', '114', '81'], ['40', '102', '119', '82']],
};
const SHOES = {
  columns: ['UK / India', 'EU', 'US (men)', 'US (women)', 'Foot length'],
  rows: [
    ['5', '38', '6', '7', '23.8'], ['6', '39', '7', '8', '24.6'], ['7', '40.5', '8', '9', '25.4'], ['8', '42', '9', '10', '26.2'],
    ['9', '43', '10', '11', '27.1'], ['10', '44.5', '11', '12', '27.9'], ['11', '45.5', '12', '13', '28.8'],
  ],
};
function chartFor(product) {
  const kind = `${product.subCategory || ''} ${product.name}`.toLowerCase();
  if (/shoe|footwear|sneaker|sandal|slipper|heel|boot|flip-flop/.test(kind)) return { title: 'Shoe sizes', unit: 'Foot length in cm', ...SHOES };
  if (/jeans|bottom|trouser|pant|short|skirt/.test(kind)) return { title: 'Waist sizes', unit: 'Body measurements in cm', ...BOTTOMS };
  return { title: 'Clothing sizes', unit: 'Body measurements in cm', ...APPAREL };
}

function SizeGuide({ product, onClose }) {
  const closeRef = useRef(null);
  const chart = chartFor(product);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.(); // back to the "Size guide" button
    };
  }, [onClose]);
  const offered = (size) => product.sizes?.some((s) => s.toLowerCase() === size.toLowerCase());
  return (
    <div className="size-guide-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="size-guide" role="dialog" aria-modal="true" aria-labelledby="size-guide-title">
        <header>
          <h2 id="size-guide-title">{chart.title}</h2>
          <button type="button" ref={closeRef} onClick={onClose} aria-label="Close size guide"><Icon name="x" size={18} /></button>
        </header>
        <p className="muted small">
          {chart.unit}. This is a standard chart: fit varies by brand, so check the description too
          {product.fit ? ` (this one is a ${product.fit.toLowerCase()} fit)` : ''}.
        </p>
        <div className="size-guide-table">
          <table>
            <thead><tr>{chart.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {chart.rows.map((r) => (
                <tr key={r[0]} className={offered(r[0]) ? 'offered' : ''}>
                  {r.map((v, i) => (i === 0 ? <th key={i} scope="row">{v}</th> : <td key={i}>{v}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Highlighted rows are sizes this product comes in. Between two sizes? The larger one fits more loosely.</p>
      </div>
    </div>
  );
}

// Colour swatches and size chips for products that have them. `attention` is set when the shopper tried to buy
// without a size: the size row is highlighted and the message is announced.
export default function VariantPicker({ product, value, onChange, attention = false, pickerRef }) {
  const [guide, setGuide] = useState(false);
  const sizes = product.sizes || [];
  const colors = product.colors || [];
  if (!sizes.length && !colors.length) return null;
  const soldOut = !product.stock;
  const color = value.color || colors[0];

  return (
    <div className="variant-picker" ref={pickerRef}>
      {colors.length > 0 && (
        <fieldset className="variant-row">
          <legend>Colour: <strong>{color}</strong></legend>
          <div className="swatches">
            {colors.map((c) => {
              const swatch = swatchOf(product, c);
              return (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${color === c ? 'selected' : ''} ${swatch ? '' : 'swatch-text'}`}
                  aria-pressed={color === c}
                  aria-label={c}
                  title={c}
                  onClick={() => onChange({ ...value, color: c })}
                >
                  {swatch ? <span style={{ background: swatch }} /> : c}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      {sizes.length > 0 && (
        <fieldset className={`variant-row ${attention ? 'attention' : ''}`}>
          <legend>
            <span>Size{value.size ? <>: <strong>{value.size}</strong></> : ''}</span>
            <button type="button" className="size-guide-link" onClick={() => setGuide(true)}><Icon name="shirt" size={14} /> Size guide</button>
          </legend>
          <div className="size-chips" role="radiogroup" aria-label="Size">
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={value.size === s}
                disabled={soldOut}
                className={`size-chip ${value.size === s ? 'selected' : ''}`}
                onClick={() => onChange({ ...value, size: s })}
              >
                {s}
              </button>
            ))}
          </div>
          {attention && <p className="variant-error" role="alert">Please select a size</p>}
        </fieldset>
      )}
      {guide && <SizeGuide product={product} onClose={() => setGuide(false)} />}
    </div>
  );
}
