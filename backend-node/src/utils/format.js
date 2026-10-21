const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

exports.formatPrice = (value) => inr.format(Number(value) || 0);
