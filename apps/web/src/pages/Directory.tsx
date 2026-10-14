import { useT } from '../i18n/useT.js'

export const Directory = () => {
  const { t } = useT()
  return (
    <>
      <h1>{t('directory.title')}</h1>
      <p>{t('directory.soon')}</p>
    </>
  )
}
