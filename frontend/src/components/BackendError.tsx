import './BackendError.css'

export default function BackendError() {
  return (
    <div className="backend-error">
      <div className="backend-error__icon">!</div>
      <h2>Cannot reach backend</h2>
      <p>Start the backend server with:</p>
      <code>cd backend &amp;&amp; uvicorn main:app --port 8000</code>
    </div>
  )
}
