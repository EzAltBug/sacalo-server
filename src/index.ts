import { createApp } from './app.js'

const { httpServer } = createApp()
const PORT = process.env.PORT ?? 3001
httpServer.listen(PORT, () => {
  console.log(`sacalo-server listening on :${PORT}`)
})
