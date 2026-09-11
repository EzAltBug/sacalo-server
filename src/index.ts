import { createApp } from './app.js'

const PORT = process.env.PORT ?? 3001
createApp().then(({ httpServer }) => {
  httpServer.listen(PORT, () => {
    console.log(`sacalo-server listening on :${PORT}`)
  })
})
