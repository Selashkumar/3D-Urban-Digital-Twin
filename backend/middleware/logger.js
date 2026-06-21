// quick and dirty request logger - didn't want to pull in morgan for something this simple
// format: METHOD /path 200 12ms

// ansi color codes because why not - makes tailing logs way easier
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
}

const colorizeStatus = (status) => {
  if (status >= 500) return colors.red + status + colors.reset
  if (status >= 400) return colors.yellow + status + colors.reset
  if (status >= 200) return colors.green + status + colors.reset
  return status  // 1xx/3xx just leave as is
}

const colorizeMethod = (method) => {
  return colors.cyan + colors.bold + method.padEnd(6) + colors.reset
}

const logger = (req, res, next) => {
  const start = Date.now()

  // hook into res.end to capture status after handler runs
  // originally I was using 'finish' event but end() is more reliable
  const originalEnd = res.end.bind(res)
  res.end = function(...args) {
    const elapsed = Date.now() - start
    const status = res.statusCode

    const methodStr = colorizeMethod(req.method)
    const statusStr = colorizeStatus(status)
    const pathStr = req.originalUrl || req.url
    const timeStr = colors.gray + `${elapsed}ms` + colors.reset

    console.log(`${methodStr} ${pathStr} ${statusStr} ${timeStr}`)

    return originalEnd(...args)
  }

  next()
}

module.exports = logger
