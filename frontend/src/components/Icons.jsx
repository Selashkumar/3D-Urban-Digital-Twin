import React from 'react'

export const CityIcon = ({ size = 20, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="2" y="10" width="6" height="12" rx="1" />
    <rect x="9" y="4" width="6" height="18" rx="1" />
    <rect x="16" y="8" width="6" height="14" rx="1" />
  </svg>
)

export const TruckIcon = ({ size = 16, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="1" y="3" width="15" height="13" rx="2" ry="2" />
    <polygon points="16 8 20 8 23 11 23 16 16 16" />
    <circle cx="5.5" cy="18.5" r="2.5" />
    <circle cx="18.5" cy="18.5" r="2.5" />
  </svg>
)

export const BusIcon = ({ size = 16, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="2" width="16" height="17" rx="2" ry="2" />
    <path d="M4 6h16" />
    <path d="M4 10h16" />
    <circle cx="7.5" cy="21.5" r="1.5" />
    <circle cx="16.5" cy="21.5" r="1.5" />
  </svg>
)

export const EmergencyIcon = ({ size = 16, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 19a1 1 0 01-1-1v-4a6 6 0 0112 0v4a1 1 0 01-1 1H4z" />
    <path d="M9 2v4M5 4l2.5 2.5M13 4l-2.5 2.5" />
  </svg>
)

export const DeliveryIcon = ({ size = 16, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
    <line x1="12" y1="12" x2="12" y2="22" />
  </svg>
)

export const CarIcon = ({ size = 16, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10" />
    <path d="M5 17H3c-.6 0-1-.4-1-1v-3c0-.9.7-1.7 1.5-1.9C4.3 10.6 7 10 7 10" />
    <path d="M7 10h9l2-3H6l1 3z" />
    <circle cx="7" cy="17" r="2" />
    <circle cx="17" cy="17" r="2" />
  </svg>
)

export const SatelliteIcon = ({ size = 16, ...props }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 11l8-8M13 21l8-8" />
    <rect x="9" y="9" width="6" height="6" rx="1" transform="rotate(45 12 12)" />
    <path d="M6 6l2-2M4 8l2-2M16 16l2 2M18 14l2 2" />
  </svg>
)
