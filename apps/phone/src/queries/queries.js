import { Q } from 'cozy-client'

export const buildContactsQuery = () => ({
  definition: Q('io.cozy.contacts').limitBy(1000),
  options: {
    as: 'io.cozy.contacts/allContacts'
  }
})
