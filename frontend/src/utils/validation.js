// Form rules - keep in sync with backend/src/utils/validation.js (the server re-checks everything)
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[6-9]\d{9}$/;
export const PASSWORD_MIN = 8;

export function validateName(name) {
  if (name.trim().length < 2) return 'Please enter your full name';
  return '';
}

export function validateEmail(email) {
  const value = email.trim();
  if (!value) return 'Please enter your email address';
  if (!EMAIL_RE.test(value) || value.includes('..')) return 'Please enter a valid email address, e.g. name@gmail.com';
  return '';
}

export function validatePhone(phone, { required = false } = {}) {
  if (!phone) return required ? 'Please enter your mobile number' : '';
  if (!PHONE_RE.test(phone)) return 'Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9';
  return '';
}

export function validatePassword(password) {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number';
  return '';
}

// 0-4 score for the strength meter
export function passwordStrength(password) {
  if (!password) return { score: 0, label: '' };
  let score = 0;
  if (password.length >= PASSWORD_MIN) score++;
  if (password.length >= 12) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^a-z0-9]/i.test(password)) score++;
  if (validatePassword(password)) score = Math.min(score, 1);
  return { score, label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}
